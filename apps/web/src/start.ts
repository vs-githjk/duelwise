import { createStart } from '@tanstack/react-start'
import { safeErrorsMiddleware } from './server/safe-errors'

export const startInstance = createStart(() => ({
  functionMiddleware: [safeErrorsMiddleware],
}))
