export const gexModes = ['net', 'split', 'call', 'put', 'abs', 'profile'] as const
export type GexModeOption = (typeof gexModes)[number]

export const gexModeLabels: Record<GexModeOption, string> = {
  net: 'Net',
  split: 'Split',
  call: 'Call',
  put: 'Put',
  abs: 'Abs',
  profile: 'Profile',
}

export function getGexChartTitle(mode: GexModeOption) {
  if (mode === 'net') {
    return 'NET GAMMA EXPOSURE'
  }

  if (mode === 'abs') {
    return 'ABS CALL/PUT GAMMA EXPOSURE'
  }

  if (mode === 'profile') {
    return 'NET GAMMA EXPOSURE PROFILE'
  }

  return `${gexModeLabels[mode].toUpperCase()} GAMMA EXPOSURE`
}
