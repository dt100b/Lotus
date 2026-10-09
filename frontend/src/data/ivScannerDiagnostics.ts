const DIAGNOSTICS_QUERY = 'ivDiagnostics'
const DIAGNOSTICS_STORAGE_KEY = 'lotus.ivScannerDiagnostics'

/** Internal/admin view for prototype-parity and calibration controls. */
export function isIvScannerDiagnosticsEnabled(): boolean {
  if (import.meta.env.VITE_LOTUS_IV_SCANNER_DIAGNOSTICS === '1') return true
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get(DIAGNOSTICS_QUERY) === '1') return true
    return window.localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}
