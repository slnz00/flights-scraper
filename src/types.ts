export interface FlightQuery {
  // yyyy-mm-dd
  dates: `${number}-${number}-${number}`[],
  origins: string[],
  destinations: string[]
}

export interface FlightResult {
  date: string,
  origin: string,
  destination: string,
  departsAt: Date | string,
  arrivesAt: Date | string,
  url: string,
  price: number,
  carrier: string
}

export interface Trip {
  depart?: FlightQuery,
  return?: FlightQuery
}

export interface TripResult {
  depart: FlightResult[],
  return: FlightResult[]
}

export interface SkyScannerSuggestions {
  inputSuggest: {
    navigation: {
      relevantFlightParams: {
        entityId: string;
        flightPlaceType: 'CITY' | 'AIRPORT' | string;
        localizedName: string;
        skyId: string;
      }
    }
  }[]
}

export interface SkyScannerFlights {
  data: {
    itineraries: {
      buckets: {
        items: {
          legs: {
            carriers: {
              marketing: {
                name: string
              }[]
            }
            arrival: string
            departure: string
            origin: {
              name: string
            }
            destination: {
              name: string
            }
            stopCount: number
          }[]
          price: {
            raw: number
          }
        }[]
      }[]
    }
  }
}

export type CityInfo = SkyScannerSuggestions['inputSuggest'][number]['navigation']['relevantFlightParams']

export type DeepPartial<T> = T extends any[] ? T : { [P in keyof T]?: DeepPartial<T[P]> }
