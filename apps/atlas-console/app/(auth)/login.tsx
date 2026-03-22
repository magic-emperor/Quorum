import React, { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert
} from 'react-native'
import { router } from 'expo-router'
import { useAuthStore } from '../../src/store/auth'

export default function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isRegistering, setIsRegistering] = useState(false)
  const [loading, setLoading] = useState(false)
  const { login, register } = useAuthStore()

  const handleSubmit = async () => {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter email and password')
      return
    }
    setLoading(true)
    try {
      if (isRegistering) {
        await register(email, password)
      } else {
        await login(email, password)
      }
      router.replace('/(app)/')
    } catch (err: any) {
      Alert.alert('Error', err.response?.data?.error ?? 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.card}>
        <Text style={styles.logo}>⚡ ATLAS</Text>
        <Text style={styles.subtitle}>Console</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#666"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#666"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
        />

        <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={loading}>
          {loading
            ? <ActivityIndicator color="#000" />
            : <Text style={styles.buttonText}>{isRegistering ? 'Create Account' : 'Sign In'}</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setIsRegistering(r => !r)}>
          <Text style={styles.switchText}>
            {isRegistering ? 'Already have an account? Sign in' : "Don't have an account? Register"}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a1a', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#12122a', borderRadius: 16, padding: 32, borderWidth: 1, borderColor: '#2a2a4a' },
  logo: { fontSize: 36, textAlign: 'center', color: '#7c3aed', fontWeight: '900' },
  subtitle: { fontSize: 16, textAlign: 'center', color: '#888', marginBottom: 32 },
  input: {
    backgroundColor: '#1a1a2e', color: '#fff', borderRadius: 8,
    padding: 14, marginBottom: 12, fontSize: 16, borderWidth: 1, borderColor: '#2a2a4a'
  },
  button: {
    backgroundColor: '#7c3aed', borderRadius: 8, padding: 16,
    alignItems: 'center', marginTop: 8, marginBottom: 16
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  switchText: { color: '#7c3aed', textAlign: 'center', fontSize: 14 }
})
