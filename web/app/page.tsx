import { LoginScreen } from '../components/login-screen'
import { SetupScreen } from '../components/setup-screen'
import { isDashboardAuthenticated } from '../lib/auth'
import { getDashboardSetup } from '../lib/config'
import { redirect } from 'next/navigation'

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
  const setup = getDashboardSetup()

  if (!setup.configured) return <SetupScreen issues={setup.issues} apiUrl={setup.publicApiUrl} />
  if (await isDashboardAuthenticated()) redirect('/overview')
  return <LoginScreen error={error} apiUrl={setup.config.publicApiUrl} />
}
