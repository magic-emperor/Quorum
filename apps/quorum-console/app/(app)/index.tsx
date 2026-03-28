import React, { useEffect, useRef, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, Platform
} from 'react-native'
import { useSessionStore } from '../../src/store/session'
import type { TerminalLine } from '../../src/types'

export default function MainScreen() {
  const {
    mode, setMode, terminalLines, chatMessages,
    isRunning, pendingCheckpoint, executeTerminalCommand,
    sendInterrupt, respondToCheckpoint, startSession
  } = useSessionStore()
  const [input, setInput] = useState('')
  const flatListRef = useRef<FlatList>(null)

  // Auto-scroll on new output
  useEffect(() => {
    if (terminalLines.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100)
    }
  }, [terminalLines.length])

  const handleSend = () => {
    if (!input.trim()) return
    if (pendingCheckpoint) {
      respondToCheckpoint(input.trim())
    } else {
      executeTerminalCommand(input.trim())
    }
    setInput('')
  }

  const renderTerminalLine = ({ item }: { item: TerminalLine }) => {
    const color = item.type === 'input' ? '#7c3aed'
      : item.type === 'error' ? '#ef4444'
      : item.type === 'system' ? '#f59e0b'
      : item.type === 'checkpoint' ? '#10b981'
      : '#d1d5db'

    return (
      <View style={styles.line}>
        <Text style={[styles.lineText, { color }]} selectable>{item.content}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      {/* Mode toggle */}
      <View style={styles.modeBar}>
        <TouchableOpacity
          style={[styles.modeBtn, mode === 'terminal' && styles.modeBtnActive]}
          onPress={() => setMode('terminal')}
        >
          <Text style={styles.modeBtnText}>Terminal</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modeBtn, mode === 'chat' && styles.modeBtnActive]}
          onPress={() => setMode('chat')}
        >
          <Text style={styles.modeBtnText}>Chat</Text>
        </TouchableOpacity>

        {isRunning && (
          <TouchableOpacity style={styles.interruptBtn} onPress={sendInterrupt}>
            <Text style={styles.interruptText}>⬛ Stop</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Output */}
      <FlatList
        ref={flatListRef}
        data={terminalLines}
        keyExtractor={item => item.id}
        renderItem={renderTerminalLine}
        style={styles.output}
        contentContainerStyle={styles.outputContent}
      />

      {/* Checkpoint banner */}
      {pendingCheckpoint && (
        <View style={styles.checkpointBanner}>
          <Text style={styles.checkpointText}>⏸ {pendingCheckpoint.message}</Text>
        </View>
      )}

      {/* Input bar */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.inputBar}>
          <Text style={styles.prompt}>›</Text>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            onSubmitEditing={handleSend}
            placeholder={pendingCheckpoint ? 'Type your response...' : 'Type command or message...'}
            placeholderTextColor="#555"
            returnKeyType="send"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.sendBtn} onPress={handleSend}>
            <Text style={styles.sendText}>↑</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  modeBar: {
    flexDirection: 'row', backgroundColor: '#111', paddingHorizontal: 12,
    paddingTop: 48, paddingBottom: 8, gap: 8, alignItems: 'center'
  },
  modeBtn: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 6, backgroundColor: '#1a1a1a' },
  modeBtnActive: { backgroundColor: '#7c3aed' },
  modeBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  interruptBtn: { marginLeft: 'auto', paddingHorizontal: 16, paddingVertical: 6, backgroundColor: '#7f1d1d', borderRadius: 6 },
  interruptText: { color: '#fca5a5', fontSize: 13, fontWeight: '600' },
  output: { flex: 1 },
  outputContent: { padding: 12, gap: 2 },
  line: { paddingVertical: 2 },
  lineText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20 },
  checkpointBanner: {
    backgroundColor: '#064e3b', padding: 12, borderTopWidth: 1, borderTopColor: '#10b981'
  },
  checkpointText: { color: '#6ee7b7', fontSize: 14 },
  inputBar: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#111',
    borderTopWidth: 1, borderTopColor: '#222', paddingHorizontal: 12,
    paddingVertical: 8, paddingBottom: Platform.OS === 'ios' ? 24 : 8
  },
  prompt: { color: '#7c3aed', fontSize: 18, marginRight: 8, fontWeight: '700' },
  input: {
    flex: 1, color: '#fff', fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'
  },
  sendBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: '#7c3aed',
    alignItems: 'center', justifyContent: 'center', marginLeft: 8
  },
  sendText: { color: '#fff', fontSize: 16, fontWeight: '700' }
})
