/**
 * ARCHIVED — Include OTC Prints chart chrome
 *
 * Not mounted on the live terminal. Kept for a possible future re-enable.
 * See: project/docs/archived_include_otc_prints.md
 *
 * Re-enable sketch:
 * 1. materialize with enable_include_otc_secondary=True
 * 2. restore PaneCellState.includeOtcPrints (boolean, default false)
 * 3. mount <OtcPrintsSelect /> in WorkspacePaneCell ChartControls for net/profile
 * 4. when includeOtcPrints && snapshot.gammaBarsIncludeOtc:
 *      GexProfileChart({
 *        snapshot: { spot, gammaBars: snapshot.gammaBarsIncludeOtc },
 *        colorPalette: 'include_otc',
 *      })
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type OtcPrintsSelectProps = {
  includeOtcPrints: boolean
  otcAvailable: boolean
  onChange: (include: boolean) => void
}

/** Ledger-policy toggle: production (exclude blocks/combos) vs include OTC prints. */
export function OtcPrintsSelect({
  includeOtcPrints,
  otcAvailable,
  onChange,
}: OtcPrintsSelectProps) {
  return (
    <Select
      value={includeOtcPrints ? 'include' : 'exclude'}
      onValueChange={(value) => {
        if (value === 'include' && !otcAvailable) return
        onChange(value === 'include')
      }}
    >
      <SelectTrigger
        aria-label="OTC prints ledger policy"
        title={
          otcAvailable
            ? 'Compare production (blocks excluded) vs include OTC block/combo prints'
            : 'Include-OTC profile not on this snapshot yet — run a full materialize with --include-otc-secondary'
        }
        className="chart-chrome-control h-5 min-h-5 max-h-5 min-w-[118px] max-w-[148px] shrink-0 gap-1 px-2 text-[8.5px] leading-none tracking-[0.07em] [&>span]:truncate [&>span]:text-[8.5px] [&>span]:leading-none [&_svg]:h-2.5 [&_svg]:w-2.5"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[160px]">
        <SelectItem
          value="exclude"
          className="py-1.5 pl-5 pr-2 text-[8.5px] leading-none tracking-[0.07em] [&_svg]:h-3 [&_svg]:w-3"
        >
          Exclude OTC Prints
        </SelectItem>
        <SelectItem
          value="include"
          disabled={!otcAvailable}
          className="py-1.5 pl-5 pr-2 text-[8.5px] leading-none tracking-[0.07em] [&_svg]:h-3 [&_svg]:w-3"
        >
          Include OTC Prints
        </SelectItem>
      </SelectContent>
    </Select>
  )
}

/** Title suffix used when include-OTC mode is active. */
export function withOtcTitleSuffix(baseTitle: string, includeOtcPrints: boolean): string {
  return includeOtcPrints ? `${baseTitle} · +OTC` : baseTitle
}
