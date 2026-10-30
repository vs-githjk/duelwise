// Dev only: throws while rendering so the error boundary can be checked in a browser.
export default function Crash(): never {
  throw new Error('dev crash view')
}
