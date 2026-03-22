import { useEffect } from 'react'
import { Stack, router } from 'expo-router'
import { useAuthStore } from '../src/store/auth'

export default function RootLayout() {
  const { token, isLoading, loadStoredToken } = useAuthStore()

  useEffect(() => {
    loadStoredToken()
  }, [])

  useEffect(() => {
    if (!isLoading) {
      if (token) {
        router.replace('/(app)/')
      } else {
        router.replace('/(auth)/login')
      }
    }
  }, [isLoading, token])

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  )
}
