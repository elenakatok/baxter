// Hand-rolled SVG scatter plot — no external charting library (matching grays house style).

const SW = 900, SH = 540
const SM = { top: 68, left: 108, right: 50, bottom: 92 }
const SPW = SW - SM.left - SM.right  // 742
const SPH = SH - SM.top - SM.bottom  // 380

const TO_M = 1_000_000  // raw scores are stored in dollars; the plot draws in millions.

export interface ScatterPoint {
  x: number  // WineMaster raw score (dollars; converted to millions at plot boundary)
  y: number  // Home Base raw score (dollars; converted to millions at plot boundary)
  label: string
}

/** Frontier endpoint — already in MILLIONS, x = WineMaster, y = Home Base. */
export interface FrontierPoint {
  x: number
  y: number
}

function niceTicks(min: number, max: number, count = 6): number[] {
  const range = max - min || 1
  const raw = range / count
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)))
  const norm = raw / mag
  const step = norm < 1.5 ? mag : norm < 3.5 ? 2 * mag : norm < 7.5 ? 5 * mag : 10 * mag
  const start = Math.ceil(min / step) * step
  const ticks: number[] = []
  // Keep fractional ticks (we now plot in millions) — display is cleaned by fmtMillions.
  for (let t = start; t <= max + step * 0.01; t += step) ticks.push(t)
  return ticks
}

// Plain decimal millions: 0, 0.5, 1, 2.5 … ($ millions lives in the axis titles, per the image).
function fmtMillions(n: number): string {
  const r = Math.round(n * 100) / 100  // clean float-accumulation noise to 2dp
  if (r === 0) return '0'
  const sign = r < 0 ? '−' : ''
  const s = Math.abs(r).toFixed(2).replace(/\.?0+$/, '')
  return sign + s
}

export function SurplusScatterSVG({
  points,
  frontier,
  svgRef,
}: {
  points: ScatterPoint[]
  /** Optional Pareto frontier (two points, in MILLIONS: x = WineMaster, y = Home Base).
   *  When present, a dark-red line connects them; absent → unchanged (Hawks/Vivo unaffected). */
  frontier?: FrontierPoint[]
  svgRef: React.RefObject<SVGSVGElement | null>
}) {
  if (points.length === 0) {
    return (
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${SW} ${SH}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <rect width={SW} height={SH} fill="#ffffff" />
        <text x={SW / 2} y={SH / 2} textAnchor="middle" fontSize={16} fill="#9ca3af" fontFamily="sans-serif">
          No completed groups yet.
        </text>
      </svg>
    )
  }

  // Convert dots from dollars → millions at the plot boundary; frontier is already in millions.
  const mpts = points.map(p => ({ ...p, x: p.x / TO_M, y: p.y / TO_M }))
  const fr = frontier ?? []

  // Auto-scale over BOTH the dots and the frontier endpoints so the line isn't clipped.
  const allX = [...mpts.map(p => p.x), ...fr.map(p => p.x)]
  const allY = [...mpts.map(p => p.y), ...fr.map(p => p.y)]
  const rawMinX = Math.min(...allX), rawMaxX = Math.max(...allX)
  const rawMinY = Math.min(...allY), rawMaxY = Math.max(...allY)

  // Pad axes so points don't sit on the edge; always include 0 for the zero-line.
  const padX = (rawMaxX - rawMinX) * 0.12 || Math.abs(rawMinX) * 0.15 || 0.2
  const padY = (rawMaxY - rawMinY) * 0.12 || Math.abs(rawMinY) * 0.15 || 0.2
  const axisMinX = Math.min(rawMinX - padX, -0.05)
  const axisMaxX = Math.max(rawMaxX + padX, 0.05)
  const axisMinY = Math.min(rawMinY - padY, -0.05)
  const axisMaxY = Math.max(rawMaxY + padY, 0.05)

  const spanX = axisMaxX - axisMinX
  const spanY = axisMaxY - axisMinY

  const xPx = (v: number) => SM.left + ((v - axisMinX) / spanX) * SPW
  const yPx = (v: number) => SM.top + SPH - ((v - axisMinY) / spanY) * SPH

  const xTicks = niceTicks(axisMinX, axisMaxX, 7)
  const yTicks = niceTicks(axisMinY, axisMaxY, 6)

  // Zero-line positions (may be out of range — clamp via clipPath).
  const zeroX = xPx(0)
  const zeroY = yPx(0)

  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${SW} ${SH}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <rect width={SW} height={SH} fill="#ffffff" />

      {/* Title */}
      <text x={SW / 2} y={28} textAnchor="middle" fontSize={20} fontWeight={700} fill="#111" fontFamily="sans-serif">
        Surplus Scatter — Winemaster vs. Home Base
      </text>
      <text x={SW / 2} y={50} textAnchor="middle" fontSize={12} fill="#6b7280" fontFamily="sans-serif">
        One dot per group · positive = above reservation · negative = below reservation
      </text>

      {/* Clip path */}
      <defs>
        <clipPath id="wm-scatter-clip">
          <rect x={SM.left} y={SM.top} width={SPW} height={SPH} />
        </clipPath>
      </defs>

      {/* Plot background */}
      <rect x={SM.left} y={SM.top} width={SPW} height={SPH} fill="#f9fafb" stroke="#e5e7eb" />

      {/* Horizontal gridlines + y-axis labels */}
      {yTicks.map(t => {
        const y = yPx(t)
        if (y < SM.top - 1 || y > SM.top + SPH + 1) return null
        return (
          <g key={t}>
            <line x1={SM.left} y1={y} x2={SM.left + SPW} y2={y} stroke="#e5e7eb" strokeWidth={1} />
            <text x={SM.left - 8} y={y + 4} textAnchor="end" fontSize={11} fill="#9ca3af" fontFamily="sans-serif">
              {fmtMillions(t)}
            </text>
          </g>
        )
      })}

      {/* Vertical gridlines + x-axis labels */}
      {xTicks.map(t => {
        const x = xPx(t)
        if (x < SM.left - 1 || x > SM.left + SPW + 1) return null
        return (
          <g key={t}>
            <line x1={x} y1={SM.top} x2={x} y2={SM.top + SPH} stroke="#e5e7eb" strokeWidth={1} />
            <text x={x} y={SM.top + SPH + 17} textAnchor="middle" fontSize={11} fill="#6b7280" fontFamily="sans-serif">
              {fmtMillions(t)}
            </text>
          </g>
        )
      })}

      {/* Zero lines (reservation boundary) — drawn inside clip */}
      {zeroX >= SM.left && zeroX <= SM.left + SPW && (
        <line
          x1={zeroX} y1={SM.top} x2={zeroX} y2={SM.top + SPH}
          stroke="#dc2626" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.45}
          clipPath="url(#wm-scatter-clip)"
        />
      )}
      {zeroY >= SM.top && zeroY <= SM.top + SPH && (
        <line
          x1={SM.left} y1={zeroY} x2={SM.left + SPW} y2={zeroY}
          stroke="#dc2626" strokeWidth={1.5} strokeDasharray="5,4" opacity={0.45}
          clipPath="url(#wm-scatter-clip)"
        />
      )}

      {/* Pareto frontier line (dark red) — same px-scale as the dots; drawn under the dots. */}
      {fr.length >= 2 && (
        <g clipPath="url(#wm-scatter-clip)">
          <line
            x1={xPx(fr[0].x)} y1={yPx(fr[0].y)}
            x2={xPx(fr[1].x)} y2={yPx(fr[1].y)}
            stroke="#991b1b" strokeWidth={3}
          />
          {fr.map((p, i) => (
            <circle key={i} cx={xPx(p.x)} cy={yPx(p.y)} r={5} fill="#991b1b" />
          ))}
          <text
            x={(xPx(fr[0].x) + xPx(fr[1].x)) / 2 + 14}
            y={(yPx(fr[0].y) + yPx(fr[1].y)) / 2 - 8}
            fontSize={12} fontWeight={600} fill="#991b1b" fontFamily="sans-serif"
          >
            Pareto frontier
          </text>
        </g>
      )}

      {/* Axis lines */}
      <line x1={SM.left} y1={SM.top} x2={SM.left} y2={SM.top + SPH} stroke="#374151" strokeWidth={2} />
      <line x1={SM.left} y1={SM.top + SPH} x2={SM.left + SPW} y2={SM.top + SPH} stroke="#374151" strokeWidth={2} />

      {/* Y-axis title (rotated) — Home Base */}
      <text
        x={SM.left - 82} y={SM.top + SPH / 2}
        transform={`rotate(-90, ${SM.left - 82}, ${SM.top + SPH / 2})`}
        textAnchor="middle" fontSize={13} fill="#374151" fontFamily="sans-serif"
      >
        HomeBase net gain ($ millions)
      </text>

      {/* X-axis title — WineMaster */}
      <text
        x={SM.left + SPW / 2} y={SM.top + SPH + 48}
        textAnchor="middle" fontSize={13} fill="#374151" fontFamily="sans-serif"
      >
        WineMaster net gain ($ millions)
      </text>

      {/* Data points + labels */}
      {mpts.map((p, i) => {
        const cx = xPx(p.x)
        const cy = yPx(p.y)
        // Offset label above the dot; flip below if too close to top edge.
        const labelY = cy < SM.top + 22 ? cy + 18 : cy - 12
        return (
          <g key={i} clipPath="url(#wm-scatter-clip)">
            <circle cx={cx} cy={cy} r={9} fill="#2563eb" opacity={0.78} />
            <text
              x={cx} y={labelY}
              textAnchor="middle" fontSize={11} fontWeight={600}
              fill="#1e3a8a" fontFamily="sans-serif"
            >
              {p.label}
            </text>
          </g>
        )
      })}

      {/* Point count */}
      <text x={SW - SM.right} y={SM.top - 10} textAnchor="end" fontSize={12} fill="#9ca3af" fontFamily="sans-serif">
        N = {points.length} group{points.length !== 1 ? 's' : ''}
      </text>
    </svg>
  )
}
