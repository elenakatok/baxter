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

const baxterInfoLinks = [
  { roleKey: 'baxter', links: [
    { key: 'baxter_sheet_url',     label: 'Role sheet' },
    { key: 'baxter_worksheet_url', label: 'Worksheet'  },
  ]},
  { roleKey: 'union', links: [
    { key: 'union_sheet_url',     label: 'Role sheet' },
    { key: 'union_worksheet_url', label: 'Worksheet'  },
  ]},
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
            roleInfoLinks={baxterInfoLinks}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
