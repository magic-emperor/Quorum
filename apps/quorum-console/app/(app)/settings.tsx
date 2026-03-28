import React, { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, Alert, ActivityIndicator
} from 'react-native'
import { useAuthStore } from '../../src/store/auth'
import { api } from '../../src/lib/api'

const PROVIDERS = [
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI (GPT-4)' },
  { key: 'GOOGLE_AI_API_KEY', label: 'Google (Gemini)' },
  { key: 'GROQ_API_KEY', label: 'Groq (Llama)' },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
  { key: 'MISTRAL_API_KEY', label: 'Mistral' },
] as const

export default function SettingsScreen() {
  const { user, logout } = useAuthStore()
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [saving, setSaving] = useState(false)

  const saveKey = async () => {
    if (!selectedProvider || !keyInput.trim()) return
    setSaving(true)
    try {
      await api.post('/api/keys', { provider: selectedProvider, key: keyInput.trim() })
      Alert.alert('Saved', `${selectedProvider} key saved securely.`)
      setKeyInput('')
      setSelectedProvider(null)
    } catch {
      Alert.alert('Error', 'Failed to save key. Check the server connection.')
    } finally {
      setSaving(false)
    }
  }

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure?', [
      { text: 'Cancel' },
      { text: 'Logout', style: 'destructive', onPress: logout }
    ])
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <Text style={styles.section}>Account</Text>
      <View style={styles.card}>
        <Text style={styles.email}>{user?.email}</Text>
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.section}>API Keys</Text>
      <Text style={styles.hint}>Keys are stored AES-256 encrypted on the server.</Text>

      <FlatList
        data={PROVIDERS}
        keyExtractor={item => item.key}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.providerRow, selectedProvider === item.key && styles.providerRowActive]}
            onPress={() => setSelectedProvider(p => p === item.key ? null : item.key)}
          >
            <Text style={styles.providerLabel}>{item.label}</Text>
            <Text style={styles.providerKey}>{item.key}</Text>
          </TouchableOpacity>
        )}
        style={styles.providerList}
      />

      {selectedProvider && (
        <View style={styles.keyEntry}>
          <TextInput
            style={styles.keyInput}
            placeholder={`Paste ${selectedProvider}...`}
            placeholderTextColor="#555"
            value={keyInput}
            onChangeText={setKeyInput}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <TouchableOpacity style={styles.saveBtn} onPress={saveKey} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveBtnText}>Save</Text>}
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a1a', padding: 20, paddingTop: 56 },
  title: { color: '#fff', fontSize: 24, fontWeight: '900', marginBottom: 24 },
  section: { color: '#888', fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' },
  hint: { color: '#555', fontSize: 12, marginBottom: 12 },
  card: { backgroundColor: '#12122a', borderRadius: 12, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: '#2a2a4a' },
  email: { color: '#d1d5db', fontSize: 16, marginBottom: 12 },
  logoutBtn: { backgroundColor: '#7f1d1d', borderRadius: 8, padding: 10, alignItems: 'center' },
  logoutText: { color: '#fca5a5', fontWeight: '700' },
  providerList: { marginBottom: 16 },
  providerRow: {
    backgroundColor: '#12122a', borderRadius: 8, padding: 14,
    marginBottom: 6, borderWidth: 1, borderColor: '#2a2a4a'
  },
  providerRowActive: { borderColor: '#7c3aed', backgroundColor: '#1e103d' },
  providerLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  providerKey: { color: '#666', fontSize: 12, marginTop: 2 },
  keyEntry: { backgroundColor: '#12122a', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#7c3aed' },
  keyInput: {
    color: '#fff', backgroundColor: '#0a0a0a', borderRadius: 8,
    padding: 12, marginBottom: 10, fontFamily: 'monospace', fontSize: 13
  },
  saveBtn: { backgroundColor: '#7c3aed', borderRadius: 8, padding: 12, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '700' }
})
