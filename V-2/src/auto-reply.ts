import fs from 'node:fs'
import path from 'node:path'
import type { MessageRepository, StoredMessage } from './db.js'
import { getGeminiKeys, getAvailableFlashModels } from './gemini.js'

// Use process.cwd() so paths remain consistent in both src/ and dist/
const dataDir = path.resolve(process.cwd(), 'data')
const CONFIG_PATH = path.join(dataDir, 'auto_reply_config.json')
const EXCLUDE_PATH = path.join(dataDir, 'auto_reply_exclude.json')

export const DISCLOSURE_TEXT = "\n\n(Andy's AI assistant replying — he'll get back to you personally soon)"

// Track last auto-reply timestamp per contact to determine session boundaries (24h)
const lastReplyTimestamps = new Map<string, number>()

// Track message IDs sent programmatically by the bot so they aren't confused with Andy's manual messages
const botSentMessageIds = new Set<string>()

export function markBotMessageId(id: string): void {
  if (!id) return
  botSentMessageIds.add(id)
  if (botSentMessageIds.size > 2000) {
    const oldest = botSentMessageIds.values().next().value
    if (oldest) botSentMessageIds.delete(oldest)
  }
}

export function isBotMessageId(id: string): boolean {
  return botSentMessageIds.has(id)
}

type PendingAutoReply = {
  chatJid: string
  incomingMessageId: string
  incomingText: string
  timer: NodeJS.Timeout
  scheduledAt: number
}

const pendingAutoReplies = new Map<string, PendingAutoReply>()

export function isAutoReplyEnabled(): boolean {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log(`[AutoReply Config] Config file not found at ${CONFIG_PATH}, defaulting to disabled (false)`)
      return false
    }
    const content = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    const enabled = Boolean(content.enabled)
    console.log(`[AutoReply Config] Read enabled status: ${enabled} from ${CONFIG_PATH}`)
    return enabled
  } catch (err: any) {
    console.error(`[AutoReply Config] Failed to read config from ${CONFIG_PATH}:`, err.message)
    return false
  }
}

export function setAutoReplyEnabled(enabled: boolean): void {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ enabled }, null, 2), 'utf-8')
    console.log(`[AutoReply Config] Saved enabled status: ${enabled} to ${CONFIG_PATH}`)
  } catch (err: any) {
    console.error(`[AutoReply Config] Failed to save config to ${CONFIG_PATH}:`, err.message)
  }
}

export function getExcludedNumbers(): string[] {
  try {
    if (!fs.existsSync(EXCLUDE_PATH)) {
      console.log(`[AutoReply Exclude] Exclude file not found at ${EXCLUDE_PATH}`)
      return []
    }
    const content = JSON.parse(fs.readFileSync(EXCLUDE_PATH, 'utf-8'))
    const list = Array.isArray(content.excludedNumbers) ? content.excludedNumbers : []
    return list.map((n: string) => String(n).replace(/\D/g, '')).filter(Boolean)
  } catch (err: any) {
    console.error(`[AutoReply Exclude] Failed to read exclude list from ${EXCLUDE_PATH}:`, err.message)
    return []
  }
}

export function isExcludedContact(jid: string): boolean {
  const normalizedJid = jid.split('@')[0].replace(/\D/g, '')
  const excluded = getExcludedNumbers()
  const match = excluded.includes(normalizedJid)
  console.log(`[AutoReply Exclude Check] JID=${jid} (Normalized=${normalizedJid}) against ExcludeList=[${excluded.join(', ')}] -> ${match ? 'EXCLUDED' : 'NOT EXCLUDED'}`)
  return match
}

export async function callGeminiApi(systemPrompt: string, userMessage: string, contextMessages: StoredMessage[] = []): Promise<string | null> {
  const keys = getGeminiKeys()
  if (keys.length === 0) {
    console.warn('[AutoReply Gemini] No GEMINI_API_KEY configured in environment.')
    return null
  }

  const models = await getAvailableFlashModels(keys[0])

  const historyParts = contextMessages.map(msg => ({
    role: msg.senderJid.includes(process.env.OWNER_NUMBER ?? '923333425155') ? 'model' : 'user',
    parts: [{ text: (msg.textBody || msg.caption || '').trim() }]
  })).filter(h => h.parts[0].text.length > 0)

  const contents = [
    ...historyParts,
    { role: 'user', parts: [{ text: userMessage }] }
  ]

  for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
    const key = keys[keyIdx]
    for (const model of models) {
      try {
        console.log(`[AutoReply Gemini] Attempting call with key #${keyIdx + 1} and model ${model}...`)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 8000)

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents
          })
        })

        clearTimeout(timeoutId)

        if (response.status === 404) continue
        if (!response.ok) {
          const errText = await response.text()
          console.warn(`[AutoReply Gemini] Warning (${model}, key #${keyIdx + 1}, status ${response.status}): ${errText.slice(0, 100)}`)
          continue
        }

        const data: any = await response.json()
        const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        if (replyText) {
          console.log(`[AutoReply Gemini] Success (${model}, key #${keyIdx + 1})! Reply generated: "${replyText.slice(0, 80)}..."`)
          return replyText
        }
      } catch (err: any) {
        console.warn(`[AutoReply Gemini] Error calling ${model} with key #${keyIdx + 1}:`, err.message)
      }
    }
  }

  console.warn('[AutoReply Gemini] All Gemini API keys & models failed or exhausted quota.')
  return null
}

export async function transcribeAudioWithGemini(audioBuffer: Buffer, rawMimeType: string): Promise<string> {
  const keys = getGeminiKeys()
  if (keys.length === 0) {
    throw new Error('No GEMINI_API_KEY configured in environment.')
  }

  const cleanMime = (rawMimeType || 'audio/ogg').split(';')[0].trim()
  const base64Audio = audioBuffer.toString('base64')

  const prompt = 'Transcribe this audio exactly as spoken. Write Urdu speech in Roman Urdu (Latin script, not Urdu/Nastaliq script). If any words in the audio are in English, keep those exact words in English — do not translate them. Do not convert, translate, or paraphrase anything — this must be a literal, verbatim transcription of exactly what was said, in the language it was said in, just written in Latin letters throughout. Return ONLY the transcription with no explanation.'

  const models = await getAvailableFlashModels(keys[0])

  let lastError = 'All Gemini API keys & models failed or exhausted quota (429).'

  for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
    const key = keys[keyIdx]
    for (const model of models) {
      try {
        console.log(`[Transcribe Gemini] Attempting call with key #${keyIdx + 1} and model ${model}...`)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 15000)

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType: cleanMime,
                      data: base64Audio
                    }
                  }
                ]
              }
            ]
          })
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          const errText = await response.text()
          console.warn(`[Transcribe Gemini] Warning (${model}, key #${keyIdx + 1}, status ${response.status}): ${errText.slice(0, 100)}`)
          lastError = `HTTP ${response.status}: ${errText.slice(0, 100)}`
          continue
        }

        const data: any = await response.json()
        const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        if (replyText) {
          console.log(`[Transcribe Gemini] Success (${model}, key #${keyIdx + 1})! Transcribed ${replyText.length} chars.`)
          return replyText
        }
      } catch (err: any) {
        console.warn(`[Transcribe Gemini] Error calling ${model} with key #${keyIdx + 1}:`, err.message)
        lastError = err.message
      }
    }
  }

  throw new Error(lastError)
}

export async function generateAutoReply(
  chatJid: string,
  incomingText: string,
  repo: MessageRepository
): Promise<string | null> {
  console.log(`\n--- [AutoReply Generating] ---`)
  console.log(`[AutoReply] Chat JID: ${chatJid}`)
  console.log(`[AutoReply] Incoming Text: "${incomingText.slice(0, 80)}"`)

  // Rule 1: Never auto-reply in groups or newsletters under any circumstance
  if (chatJid.endsWith('@g.us') || chatJid.endsWith('@newsletter')) {
    console.log(`[AutoReply] SKIPPED: Message is from group/newsletter (${chatJid})`)
    return null
  }

  // Rule 2: Check global on/off state
  const enabled = isAutoReplyEnabled()
  if (!enabled) {
    console.log(`[AutoReply] SKIPPED: Auto-reply feature is currently OFF (enabled=false)`)
    return null
  }

  // Rule 3: Check exclude list
  if (isExcludedContact(chatJid)) {
    console.log(`[AutoReply] SKIPPED: Contact ${chatJid} is in the EXCLUDE list`)
    return null
  }

  // Fetch recent conversation history
  const history = await repo.getRecentMessages(chatJid, 10).catch(err => {
    console.warn('[AutoReply] Failed to fetch history:', err.message)
    return []
  })
  console.log(`[AutoReply] Fetched ${history.length} historical messages for context`)

  const systemPrompt = `You are Andy's friendly, helpful AI assistant managing incoming WhatsApp messages while Andy is away.
Reply to the contact in a natural, polite, and helpful tone based on the ongoing conversation history.
Keep your response concise, clear, and relevant to what they asked.
Do NOT attempt to remove or hide any AI disclosures — a mandatory disclosure will be appended programmatically.`

  const aiReply = await callGeminiApi(systemPrompt, incomingText, history)
  if (!aiReply) {
    console.warn(`[AutoReply Quota Fallback] All Gemini API keys/models failed or exhausted quota for ${chatJid}. Delivering generic fallback reply.`)
    const fallbackReply = `(Andy's AI assistant replying — he'll get back to you personally soon)`
    return fallbackReply
  }

  // Clean prompt artifacts if AI generated its own disclosure
  let cleanedReply = aiReply.replace(/\(Andy's AI assistant replying.*?\)/gi, '').trim()

  // Mandatory Disclosure Logic:
  const now = Date.now()
  const lastReply = lastReplyTimestamps.get(chatJid) ?? 0
  const isFirstInSession = (now - lastReply) > (24 * 60 * 60 * 1000)
  lastReplyTimestamps.set(chatJid, now)

  // MANDATORY DISCLOSURE: Programmatically append
  cleanedReply += DISCLOSURE_TEXT
  console.log(`[AutoReply Session Check] Last reply for ${chatJid} was at ${lastReply ? new Date(lastReply).toLocaleTimeString() : 'Never'}. isFirstInSession=${isFirstInSession}. Disclosure appended.`)

  console.log(`[AutoReply] FINAL OUTPUT READY FOR DELIVERY to ${chatJid}:\n"${cleanedReply}"\n---`)
  return cleanedReply
}

export function cancelPendingAutoReply(chatJid: string, reason: string): boolean {
  if (!chatJid) return false
  const cleanNumber = chatJid.split('@')[0].split(':')[0].replace(/\D/g, '')
  if (!cleanNumber) return false

  let cancelled = false
  for (const [pendingJid, pending] of pendingAutoReplies.entries()) {
    const pendingNumber = pendingJid.split('@')[0].split(':')[0].replace(/\D/g, '')
    if (pendingNumber === cleanNumber) {
      clearTimeout(pending.timer)
      pendingAutoReplies.delete(pendingJid)
      console.log(`[AutoReply Cancelled] 🛑 Pending 10s timer for ${pendingJid} CANCELLED. Reason: ${reason}`)
      cancelled = true
    }
  }

  return cancelled
}

export function scheduleAutoReply(
  sock: any,
  chatJid: string,
  incomingMessageId: string,
  incomingText: string,
  repo: MessageRepository,
  delayMs = 10000
): void {
  console.log(`[AutoReply Schedule] Received schedule request for ${chatJid} (MsgID: ${incomingMessageId})`)

  // Pre-checks before starting timer:
  if (chatJid.endsWith('@g.us') || chatJid.endsWith('@newsletter')) {
    console.log(`[AutoReply Schedule] Skipped timer: ${chatJid} is a group or newsletter`)
    return
  }

  if (!isAutoReplyEnabled()) {
    console.log(`[AutoReply Schedule] Skipped timer: Auto-reply is OFF`)
    return
  }

  if (isExcludedContact(chatJid)) {
    console.log(`[AutoReply Schedule] Skipped timer: ${chatJid} is in exclude list`)
    return
  }

  // Cancel any existing pending timer for this contact (debouncing multiple fast messages)
  if (cancelPendingAutoReply(chatJid, `New incoming message from same contact (debouncing timer for msgId: ${incomingMessageId})`)) {
    console.log(`[AutoReply Schedule] Reset 10-second timer for ${chatJid}`)
  }

  console.log(`[AutoReply Schedule] ⏱️ Starting 10-second timer for ${chatJid} (MsgID: ${incomingMessageId}). Target execution: ${new Date(Date.now() + delayMs).toLocaleTimeString()}`)

  const timer = setTimeout(async () => {
    if (!pendingAutoReplies.has(chatJid)) {
      console.log(`[AutoReply Schedule] 10s timer fired for ${chatJid}, but timer was already cancelled. Skipping.`)
      return
    }

    pendingAutoReplies.delete(chatJid)
    console.log(`[AutoReply Schedule] ⏰ 10 seconds elapsed without Andy reading or replying. Generating auto-reply for ${chatJid}...`)

    try {
      const autoReplyText = await generateAutoReply(chatJid, incomingText, repo)
      if (autoReplyText) {
        console.log(`[AutoReply Schedule] Delivering auto-reply to ${chatJid}...`)
        const sent: any = await sock.sendMessage(chatJid, { text: autoReplyText })
        if (sent?.key?.id) {
          markBotMessageId(sent.key.id)
          console.log(`[AutoReply Schedule] Marked bot outgoing msgId: ${sent.key.id}`)
        }
        console.log(`[AutoReply Schedule] ✅ Successfully delivered auto-reply to ${chatJid}`)
      }
    } catch (err: any) {
      console.error(`[AutoReply Schedule] Error sending auto-reply to ${chatJid}:`, err.message)
    }
  }, delayMs)

  pendingAutoReplies.set(chatJid, {
    chatJid,
    incomingMessageId,
    incomingText,
    timer,
    scheduledAt: Date.now()
  })
}
