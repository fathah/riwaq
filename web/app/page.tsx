import { Dashboard } from '../components/dashboard'
import { LoginScreen } from '../components/login-screen'
import { SetupScreen } from '../components/setup-screen'
import { isDashboardAuthenticated } from '../lib/auth'
import { getDashboardSetup } from '../lib/config'
import { getDashboardData } from '../lib/riwaq'

export const dynamic = 'force-dynamic'

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default async function Home({ searchParams }: PageProps) {
  const query = await searchParams
  const error = queryValue(query.error)
  const notice = queryValue(query.notice)
  const setup = getDashboardSetup()

  if (!setup.configured) return <SetupScreen issues={setup.issues} apiUrl={setup.publicApiUrl} />
  if (!(await isDashboardAuthenticated())) return <LoginScreen error={error} apiUrl={setup.config.publicApiUrl} />

  try {
    const data = await getDashboardData()
    return <Dashboard {...data} apiUrl={setup.config.publicApiUrl} error={error} notice={notice} />
  } catch (cause) {
    return (
      <SetupScreen
        issues={[cause instanceof Error ? cause.message : 'Unable to connect to the Riwaq API']}
        apiUrl={setup.config.publicApiUrl}
        connectionError
      />
    )
  }
}
