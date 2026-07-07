import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailWorker } from './email.worker';
import { EmailPort, EmailMessage } from './email.port';

/** Reads the worker's private `logger` field with a known type (avoids `any`). */
function getLogger(worker: EmailWorker): Logger {
  return (worker as unknown as { logger: Logger }).logger;
}

/** Builds a bare-bones BullMQ Job stub for EmailWorker.process(). */
function makeJob(
  overrides: Partial<{ attemptsMade: number; attempts: number }> = {},
): Job<EmailMessage> {
  const { attemptsMade = 1, attempts = 3 } = overrides;
  return {
    data: {
      to: 'user@example.com',
      subject: 'Hola',
      html: '<p>hola</p>',
      text: 'hola',
    },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<EmailMessage>;
}

describe('EmailWorker', () => {
  let emailPort: jest.Mocked<EmailPort>;
  let worker: EmailWorker;

  beforeEach(() => {
    emailPort = { send: jest.fn() };
    worker = new EmailWorker(emailPort);
  });

  it('sends the job payload through EMAIL_PORT', async () => {
    emailPort.send.mockResolvedValue(undefined);
    const job = makeJob();

    await worker.process(job);

    expect(emailPort.send).toHaveBeenCalledWith(job.data);
  });

  it('rethrows the error so BullMQ can retry when attempts remain', async () => {
    emailPort.send.mockRejectedValue(new Error('smtp down'));
    const job = makeJob({ attemptsMade: 1, attempts: 3 });

    await expect(worker.process(job)).rejects.toThrow('smtp down');
  });

  it('logs failure on the final attempt', async () => {
    emailPort.send.mockRejectedValue(new Error('smtp down'));
    const job = makeJob({ attemptsMade: 3, attempts: 3 });
    const errorSpy = jest
      .spyOn(getLogger(worker), 'error')
      .mockImplementation();

    await expect(worker.process(job)).rejects.toThrow('smtp down');

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not log an error-level failure when attempts remain', async () => {
    emailPort.send.mockRejectedValue(new Error('smtp down'));
    const job = makeJob({ attemptsMade: 1, attempts: 3 });
    const errorSpy = jest
      .spyOn(getLogger(worker), 'error')
      .mockImplementation();

    await expect(worker.process(job)).rejects.toThrow('smtp down');

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
