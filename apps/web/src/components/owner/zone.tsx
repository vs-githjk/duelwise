import { createContext, useContext } from 'react'
import { shortDateIn, timeIn } from '../../server/owner-zone'

/** The zone the server used for the numbers on this page, so every time shown here is on the same clock. */
const ZoneContext = createContext('UTC')
export const ZoneProvider = ZoneContext.Provider
export const useZone = () => useContext(ZoneContext)

/** Date and time of an instant on the page's clock, for example "Nov 1 22:49". */
export const useWhen = () => {
  const zone = useZone()
  return {
    time: (iso: string) => timeIn(iso, zone),
    date: (iso: string) => shortDateIn(iso, zone),
    both: (iso: string) => `${shortDateIn(iso, zone)} ${timeIn(iso, zone)}`,
  }
}
