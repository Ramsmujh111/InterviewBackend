import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

export interface TranscriptionError {
  message: string;
  type: 'connection' | 'rate_limit' | 'quota_exceeded' | 'timeout' | 'unknown';
  retryable: boolean;
}

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private deepgramApiKey: string;

  constructor(private configService: ConfigService) {
    this.deepgramApiKey =
      this.configService.get<string>('DEEPGRAM_API_KEY') || '';
  }

  updateApiKey(key: string) {
    this.deepgramApiKey = key;
    this.logger.log('Deepgram API key updated');
  }

  /**
   * Create a live transcription WebSocket connection to Deepgram.
   * Includes keepalive pings and auto-reconnection.
   */
  createLiveTranscription(
    onTranscript: (text: string, isFinal: boolean) => void,
    onError: (error: TranscriptionError) => void,
  ): {
    sendAudio: (data: Buffer) => void;
    close: () => void;
    isActive: () => boolean;
  } {
    if (!this.deepgramApiKey) {
      this.logger.warn('Deepgram API key not set. Transcription unavailable.');
      onError({
        message: 'Deepgram API key not configured. Add it in Settings → API Keys.',
        type: 'connection',
        retryable: false,
      });
      return {
        sendAudio: () => {},
        close: () => {},
        isActive: () => false,
      };
    }

    this.logger.log('Creating Deepgram live transcription session...');

    let ws: WebSocket | null = null;
    let isOpen = false;
    let isClosed = false; // user-initiated close
    let reconnectAttempts = 0;
    const MAX_RECONNECT = 5;
    const pendingAudio: Buffer[] = [];
    let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (isClosed) return;

      try {
        const url =
          'wss://api.deepgram.com/v1/listen' +
          '?model=nova-2&language=en' +
          '&smart_format=true&punctuate=true' +
          '&interim_results=true';

        // @ts-ignore - types mismatch with global WebSocket
        ws = new WebSocket(url, {
          headers: {
            Authorization: `Token ${this.deepgramApiKey}`,
          },
        } as any);

        ws.onopen = () => {
          this.logger.log('✅ Deepgram WebSocket connected');
          isOpen = true;
          reconnectAttempts = 0; // reset on success

          // ── Keepalive: send a ping every 8 seconds to prevent timeout ──
          if (keepaliveInterval) clearInterval(keepaliveInterval);
          keepaliveInterval = setInterval(() => {
            if (ws && isOpen) {
              try {
                // Deepgram accepts a JSON keepalive message
                ws.send(JSON.stringify({ type: 'KeepAlive' }));
              } catch {
                this.logger.warn('Keepalive send failed');
              }
            }
          }, 8000);

          // Flush any audio that arrived before connection was ready
          if (pendingAudio.length > 0) {
            this.logger.log(
              `Flushing ${pendingAudio.length} pending audio chunks`,
            );
            for (const chunk of pendingAudio) {
              ws?.send(chunk);
            }
            pendingAudio.length = 0;
          }
        };

        ws.onmessage = (event: any) => {
          try {
            const raw =
              typeof event.data === 'string'
                ? event.data
                : String(event.data);
            const data = JSON.parse(raw) as {
              type?: string;
              channel?: {
                alternatives?: { transcript?: string }[];
              };
              is_final?: boolean;
              speech_final?: boolean;
            };

            // Log metadata
            if (data.type === 'Metadata') {
              this.logger.log(
                `Deepgram metadata: ${JSON.stringify(data).substring(0, 200)}`,
              );
              return;
            }

            const transcript = data.channel?.alternatives?.[0]?.transcript;
            const isFinal = data.is_final ?? false;

            if (transcript && transcript.trim().length > 0) {
              this.logger.log(
                `🎤 Transcript (${isFinal ? 'FINAL' : 'interim'}): "${transcript.trim()}"`,
              );
              onTranscript(transcript.trim(), isFinal);
            }
          } catch (err: unknown) {
            const errMsg =
              err instanceof Error ? err.message : 'Unknown error';
            this.logger.error(
              `Failed to parse Deepgram response: ${errMsg}`,
            );
          }
        };

        ws.onerror = (event: any) => {
          const errMessage = event?.message || 'Unknown error';
          this.logger.error(
            `❌ Deepgram WebSocket error: ${errMessage}`,
          );

          // Detect rate limit / quota errors
          if (
            errMessage.includes('402') ||
            errMessage.includes('quota') ||
            errMessage.includes('insufficient')
          ) {
            onError({
              message:
                'Deepgram quota/credits exhausted. Please check your Deepgram plan or add credits.',
              type: 'quota_exceeded',
              retryable: false,
            });
          } else if (
            errMessage.includes('429') ||
            errMessage.includes('Too Many Requests') ||
            errMessage.includes('rate')
          ) {
            onError({
              message:
                'Deepgram rate limit reached. Please wait a moment before trying again.',
              type: 'rate_limit',
              retryable: true,
            });
          } else {
            onError({
              message: `Deepgram connection error: ${errMessage}`,
              type: 'connection',
              retryable: true,
            });
          }
        };

        ws.onclose = (event: any) => {
          isOpen = false;

          // Stop keepalive
          if (keepaliveInterval) {
            clearInterval(keepaliveInterval);
            keepaliveInterval = null;
          }

          const code = event?.code;
          const reason = event?.reason || 'none';
          this.logger.log(
            `Deepgram WebSocket closed (code: ${code}, reason: ${reason})`,
          );

          // ── Classify close reason ──
          if (isClosed) {
            // User-initiated close, don't reconnect
            return;
          }

          if (code === 1011 && reason.includes('timeout')) {
            this.logger.warn(
              'Deepgram timed out (no audio). Auto-reconnecting...',
            );
            onError({
              message: 'Deepgram timed out due to silence. Reconnecting...',
              type: 'timeout',
              retryable: true,
            });
            scheduleReconnect();
          } else if (code === 1008 || reason.includes('limit')) {
            onError({
              message:
                'Deepgram limit reached. Check your API usage/plan.',
              type: 'quota_exceeded',
              retryable: false,
            });
          } else if (code !== 1000) {
            // Abnormal close — attempt reconnect
            this.logger.warn(
              `Deepgram closed unexpectedly (${code}). Auto-reconnecting...`,
            );
            scheduleReconnect();
          }
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        this.logger.error(
          `Failed to create Deepgram connection: ${errMsg}`,
        );
        onError({
          message: `Deepgram connection failed: ${errMsg}`,
          type: 'connection',
          retryable: true,
        });
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (isClosed || reconnectAttempts >= MAX_RECONNECT) {
        if (reconnectAttempts >= MAX_RECONNECT) {
          this.logger.error(
            `Max reconnection attempts (${MAX_RECONNECT}) reached. Giving up.`,
          );
          onError({
            message: `Deepgram reconnection failed after ${MAX_RECONNECT} attempts. Please restart the session.`,
            type: 'connection',
            retryable: false,
          });
        }
        return;
      }

      reconnectAttempts++;
      const delayMs = Math.min(
        Math.pow(2, reconnectAttempts) * 1000,
        15000,
      ); // 2s, 4s, 8s, 15s, 15s
      this.logger.log(
        `Reconnecting to Deepgram in ${delayMs / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT})...`,
      );

      reconnectTimeout = setTimeout(() => {
        connect();
      }, delayMs);
    };

    // Initial connection
    connect();

    return {
      sendAudio: (data: Buffer) => {
        if (ws && isOpen) {
          ws.send(data);
        } else if (!isClosed) {
          // Buffer audio while WebSocket is connecting/reconnecting
          if (pendingAudio.length < 100) {
            // Cap buffer to prevent memory leak
            pendingAudio.push(data);
          }
        }
      },
      close: () => {
        isClosed = true;
        if (keepaliveInterval) {
          clearInterval(keepaliveInterval);
          keepaliveInterval = null;
        }
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = null;
        }
        if (ws) {
          ws.close();
          ws = null;
          isOpen = false;
        }
      },
      isActive: () => isOpen && !isClosed,
    };
  }
}
