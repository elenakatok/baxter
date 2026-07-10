import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { auth, functions } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
import Configure from './pages/Configure'
import Reports from './pages/Reports'
import { SettingsPage } from '@mygames/game-ui'

const baxterRoleLabels: Record<string, string> = {
  baxter: 'Baxter Management',
  union:  'Local 190',
}

// Phase-aware Info Links — the 10 role × round documents, grouped by round. Each key MUST match a
// configField in functions/src/gameDefinition.ts (and the roleInfoLinksByRound map): editing a path
// here writes config/main.<key>, which getInfoUrls serves for that role+round (unset → the declared
// default, so untouched = working documents out-of-the-box). Rendered via SettingsPage's
// game-specific configSections; the old flat 4-link roleInfoLinks set is removed. `kind: 'url'`.
const baxterInfoSections = [
  {
    id: 'info_1978',
    title: 'Info Links — 1978',
    fields: [
      { key: 'baxter_1978_case_url',      label: 'Baxter Management — Role packet',      kind: 'url' as const },
      { key: 'baxter_1978_worksheet_url', label: 'Baxter Management — Scoring worksheet', kind: 'url' as const },
      { key: 'union_1978_case_url',       label: 'Local 190 — Role packet',              kind: 'url' as const },
      { key: 'union_1978_worksheet_url',  label: 'Local 190 — Scoring worksheet',        kind: 'url' as const },
    ],
  },
  {
    id: 'info_1983',
    title: 'Info Links — 1983',
    fields: [
      { key: 'baxter_1983_brief_url', label: 'Baxter Management — 1983 round brief', kind: 'url' as const },
      { key: 'union_1983_brief_url',  label: 'Local 190 — 1983 round brief',         kind: 'url' as const },
    ],
  },
  {
    id: 'info_1985',
    title: 'Info Links — 1985',
    fields: [
      { key: 'baxter_1985_case_url',       label: 'Baxter Management — Role packet',   kind: 'url' as const },
      { key: 'baxter_1985_scoresheet_url', label: 'Baxter Management — Scoring sheet', kind: 'url' as const },
      { key: 'union_1985_case_url',        label: 'Local 190 — Role packet',           kind: 'url' as const },
      { key: 'union_1985_scoresheet_url',  label: 'Local 190 — Scoring sheet',         kind: 'url' as const },
    ],
  },
]

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<InstructorDashboard />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="/reports"   element={<Reports />} />
        <Route path="/settings"  element={
          <SettingsPage
            title="Settings — Baxter"
            functions={functions}
            auth={auth}
            roleLabels={baxterRoleLabels}
            // Baxter's reservation/no-deal values are baked into scoring — hide the dead section.
            showReservationPrices={false}
            // Phase-aware Info Links (10 docs, grouped by round) via game-specific configSections;
            // the old flat roleInfoLinks set is intentionally omitted.
            configSections={baxterInfoSections}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
