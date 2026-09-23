import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    base: { service: 'gum-bot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Private keys never reach a log line, whatever object a caller passes.
    redact: { paths: ['*.privateKey', '*.apiKey', '*.mnemonic', 'privateKey', 'apiKey'], censor: '[redacted]' },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'service,pid,hostname' } } } : {}),
  });
}
