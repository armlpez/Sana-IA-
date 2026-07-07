import { ConfigService } from '@nestjs/config';
import { createEmailAdapter } from './email.module';
import { LogEmailAdapter } from './adapters/log-email.adapter';
import { SmtpEmailAdapter } from './adapters/smtp-email.adapter';

/** Builds a ConfigService stub whose `get(key)` reads from `values`. */
function makeConfigService(
  values: Record<string, string | undefined>,
): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('EmailModule factory (createEmailAdapter)', () => {
  it('returns a SmtpEmailAdapter when EMAIL_TYPE=smtp', () => {
    const configService = makeConfigService({
      EMAIL_TYPE: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USER: 'user@example.com',
      SMTP_PASS: 'secret',
    });

    const adapter = createEmailAdapter(configService);

    expect(adapter).toBeInstanceOf(SmtpEmailAdapter);
  });

  it('returns a LogEmailAdapter when EMAIL_TYPE=log', () => {
    const configService = makeConfigService({ EMAIL_TYPE: 'log' });

    const adapter = createEmailAdapter(configService);

    expect(adapter).toBeInstanceOf(LogEmailAdapter);
  });

  it('defaults to LogEmailAdapter when EMAIL_TYPE is unset', () => {
    const configService = makeConfigService({});

    const adapter = createEmailAdapter(configService);

    expect(adapter).toBeInstanceOf(LogEmailAdapter);
  });

  it('throws at boot on an unknown EMAIL_TYPE value', () => {
    const configService = makeConfigService({ EMAIL_TYPE: 'carrier-pigeon' });

    expect(() => createEmailAdapter(configService)).toThrow(
      'Unknown EMAIL_TYPE: carrier-pigeon',
    );
  });
});
