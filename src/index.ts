import { google, sheets_v4 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { RequestInit } from 'node-fetch';
import * as fs from 'node:fs/promises';
import { CityInfo, DeepPartial, FlightResult, SkyScannerFlights, SkyScannerSuggestions, Trip, TripResult } from './types';
import dotenv from 'dotenv'

dotenv.config()

const SHEET_NAME = 'Repjegyek'

const trip: Trip = {
  depart: {
    origins: ['Budapest', 'Berlin', 'London'],
    destinations: ['Corfu'],
    dates: [
      '2025-09-11',
      '2025-09-12',
    ]
  },
  return: {
    origins: ['Corfu'],
    destinations: ['Budapest', 'Berlin', 'London'],
    dates: [
      '2025-09-16',
      '2025-09-17',
    ]
  }
}

const cache = {
  cityInfo: {} as Partial<Record<string, CityInfo>>
}

const flightUrl = (opt: {
  originId: string,
  destinationId: string,
  date: string
}) => `https://www.skyscanner.hu/transport/flights/${opt.originId}/${opt.destinationId}/${opt.date.replaceAll('-', '')}/?adultsv2=1&cabinclass=economy&childrenv2=&ref=home&rtn=0&preferdirects=true&outboundaltsenabled=false&inboundaltsenabled=false`

function formatTime(date: Date | string): string {
  date = new Date(date)

  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function formatDate(date: string | Date): string {
  date = new Date(date);
  const month = String(date.getMonth() + 1).padStart(2, '0'); // getMonth() is 0-based
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}.${day}.`;
}

const fetchSkyscanner = async <T>(path: string, options: RequestInit = {}): Promise<DeepPartial<T>> => {
  const { RAPID_API_KEY } = process.env;

  if (!RAPID_API_KEY) {
    throw new Error('RAPID_API_KEY environment variable is required.');
  }

  const { default: fetch } = await import('node-fetch')

  return fetch(`https://skyscanner89.p.rapidapi.com${path}`, {
    ...options,
    headers: {
      ...options.headers ?? {},
      'x-rapidapi-host': 'skyscanner89.p.rapidapi.com',
      'x-rapidapi-key': RAPID_API_KEY
    }
  }).then(res => res.json() as any)
}

function query(params: Record<string, string | number | boolean>): string {
  const query = new URLSearchParams();
  for (const key in params) {
    if (params[key] !== undefined && params[key] !== null) {
      query.append(key, String(params[key]));
    }
  }
  return '?' + query.toString();
}

async function getCityInfo (name: string): Promise<CityInfo> {
  if (cache.cityInfo[name]) {
    return cache.cityInfo[name]
  }

  const result = await fetchSkyscanner<SkyScannerSuggestions>(
    `/flights/auto-complete${query({
      query: name
    })}`
  )

  const info = result.inputSuggest?.[0]?.navigation?.relevantFlightParams;

  if (!info) {
    throw new Error(`Unknown city: ${name}, response: ${JSON.stringify(result, null, 2)}`);
  }

  cache.cityInfo[name] = info;

  return info;
}

async function getFlights (opt: {
  date: string,
  origin: string,
  destination: string
}): Promise<FlightResult[]> {
  const originInfo = await getCityInfo(opt.origin)
  const destinationInfo = await getCityInfo(opt.destination)

  const result = await fetchSkyscanner<SkyScannerFlights>(
    `/flights/one-way/list${query({
      date: opt.date,
      origin: originInfo.skyId,
      originId: originInfo.entityId,
      destination: destinationInfo.skyId,
      destinationId: destinationInfo.entityId,
      cabinClass: 'economy',
      adults: 1,
      currency: 'EUR'
    })}`
  )

  const bucket = result.data?.itineraries?.buckets?.[0];

  if (!bucket) {
    return []
  }

  const fightOptions = bucket.items!.filter((item) => item.legs[0]?.stopCount === 0)
  const results: FlightResult[] = []

  fightOptions.forEach(flight => {
    const data = flight.legs[0]

    results.push({
      date: opt.date,
      origin: data.origin.name,
      destination: data.destination.name,
      departsAt: new Date(data.departure),
      arrivesAt: new Date(data.arrival),
      url: flightUrl({
        originId: originInfo.skyId,
        destinationId: destinationInfo.skyId,
        date: opt.date
      }),
      price: flight.price.raw,
      carrier: data.carriers.marketing[0]?.name
    })
  })

  return results;
}

const getFlightResults = async (type: 'depart' | 'return'): Promise<FlightResult[]> => {
  if (!trip[type]) {
    return [];
  }

  const results: FlightResult[] = [];

  for (let origin of trip[type].origins) {
    for (let destination of trip[type].destinations) {
      for (let date of trip[type].dates) {
        results.push(...await getFlights({
          origin,
          destination,
          date
        }))
      }
    }
  }

  return results;
}

const writeToSpreadSheet = async (result: TripResult) => {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  const client = new JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth: client });

  const headers = [
    'Reptér',
    'Reptér',
    'Dátum',
    'Felszállás',
    'Érkezés',
    'Ár (EUR)',
    'Társaság'
  ].map(h => `  ${h}  `);

  const values = [
    ...result.depart,
    null,
    ...result.return
  ].map(flight => flight ? [
    flight.origin,
    flight.destination,
    `=HYPERLINK(${JSON.stringify(flight.url)}; "${formatDate(flight.date)}")`,
    formatTime(flight.departsAt),
    formatTime(flight.arrivesAt),
    flight.price,
    flight.carrier
  ] : []);

  const data = [headers, ...values];

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId
  });

  const existingSheetIndex = spreadsheet.data.sheets?.findIndex(sheet => sheet.properties?.title === SHEET_NAME) ?? -1;

  if (existingSheetIndex !== -1) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteSheet: {
            sheetId: spreadsheet.data.sheets?.[existingSheetIndex].properties?.sheetId
          }
        }]
      }
    });
  }

  const addSheetResponse = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        addSheet: {
          properties: {
            title: SHEET_NAME
          }
        }
      }]
    }
  });

  const newSheetId = addSheetResponse.data.replies?.[0].addSheet?.properties?.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: data }
  });

  // Auto-resize columns
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        autoResizeDimensions: {
          dimensions: {
            sheetId: newSheetId,
            dimension: 'COLUMNS',
            startIndex: 0,
            endIndex: headers.length
          },
        }
      }]
    }
  });


  // Merge first 2 cells (airport)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        mergeCells: {
          range: {
            sheetId: newSheetId, // ID of the sheet
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 2
          },
          mergeType: 'MERGE_ALL'
        }
      }]
    }
  });

  const requests = [
    // Center align all cells
    {
      repeatCell: {
        range: {
          sheetId: newSheetId,
          startRowIndex: 0,
          endRowIndex: data.length
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE'
          }
        },
        fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
      }
    },
    // Bold and center headers
    {
      repeatCell: {
        range: {
          sheetId: newSheetId,
          startRowIndex: 0,
          endRowIndex: 1
        },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
            verticalAlignment: 'MIDDLE',
            textFormat: {
              bold: true
            }
          }
        },
        fields: 'userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat.bold'
      }
    }
  ];

  // Apply the formatting
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests }
  });
}

async function useFileCache<T>(name: string, fetchData: () => Promise<T>): Promise<T> {
  const filePath = `cache-${name}.json`;

  try {
    const data = await fs.readFile(filePath, 'utf-8');

    if (!data.trim()) {
      throw new Error('Cache is empty');
    }

    return JSON.parse(data);
  } catch (err) {
    const result = await fetchData()

    await fs.writeFile(`cache-${name}.json`, JSON.stringify(result, null, 2), 'utf-8');

    return result
  }
}

async function main() {
  const result: TripResult = await useFileCache('results', async () => ({
    depart: await getFlightResults('depart'),
    return: await getFlightResults('return')
  }))

  await writeToSpreadSheet(result)
}

main().catch(console.error)
