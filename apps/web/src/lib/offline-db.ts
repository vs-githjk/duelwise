/**
 * The browser database for offline play: finished records waiting to upload, and unused match tickets.
 * One database, one version, so each module opens it the same way.
 */
const DB = 'duelwise-offline'
export const UPLOADS = 'uploads'
export const TICKETS = 'tickets'
/** Tickets handed out for play whose record has not been queued yet: a match that was started but not finished. */
export const CONSUMED = 'consumed'

let opening: Promise<IDBDatabase> | undefined
export function offlineDatabase(): Promise<IDBDatabase> {
  if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 3)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(UPLOADS)) db.createObjectStore(UPLOADS, { keyPath: 'matchId' })
      if (!db.objectStoreNames.contains(TICKETS)) db.createObjectStore(TICKETS, { keyPath: 'matchId' })
      if (!db.objectStoreNames.contains(CONSUMED)) db.createObjectStore(CONSUMED, { keyPath: 'matchId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch((error) => { opening = undefined; throw error })
  return opening!
}

export async function transact<T>(store: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await offlineDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const request = operation(tx.objectStore(store))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
