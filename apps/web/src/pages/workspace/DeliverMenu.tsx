import { useState } from 'react';
import { Button, Menu, Text } from '@mantine/core';
import { IconChevronDown, IconFileText, IconFileTypePdf, IconMailForward, IconPresentation } from '@tabler/icons-react';
import { api, type reportUrls } from '../../api.js';
import { notifications } from '@mantine/notifications';
import { toastOk } from '../../toast.js';
import { errorDetail, sendPackageFlow } from './deliver.js';
import type { Guard } from './nextStep.js';

/**
 * The client-facing deliverables behind one guard. Items are real buttons,
 * so a locked item cannot be opened with a click or the keyboard; the lock
 * reason sits at the top of the menu. The email item is the "Send package"
 * step: downloading the draft then records the send explicitly.
 */
export function DeliverMenu({
  urls,
  guard,
  clientId,
  period,
  primary = false,
  onPackageSent,
}: {
  urls: ReturnType<typeof reportUrls>;
  guard: Guard;
  clientId: string;
  period: string;
  /** Render as the primary button (when "Send package" is the next step). */
  primary?: boolean;
  onPackageSent: () => void;
}) {
  const [sending, setSending] = useState(false);
  const open = (url: string) => window.open(url, '_blank', 'noopener');
  const download = (url: string) => window.location.assign(url);

  /**
   * Lock first, then download the draft built from the stored PDF, so the
   * client receives exactly the frozen package. A refused lock (AI fallback,
   * failed figure check) downloads nothing and shows the build warnings.
   */
  async function sendPackage() {
    setSending(true);
    let locked = false;
    try {
      await sendPackageFlow(
        {
          markSent: async () => {
            await api.markPackageSent(clientId, period);
            locked = true;
          },
          fetchEmail: async () => {
            const res = await fetch(urls.email);
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(body.error ?? `${res.status} ${res.statusText}`);
            }
            const filename = res.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/)?.[1];
            return { blob: await res.blob(), ...(filename ? { filename } : {}) };
          },
          save: (blob, name) => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            a.click();
            URL.revokeObjectURL(a.href);
          },
        },
        `QBR-${clientId}-${period}.eml`,
      );
      toastOk('Package sent. The email draft is in your downloads; the quarter is stamped as sent.');
    } catch (e) {
      notifications.show({ color: 'act', title: 'Could not send the package', message: errorDetail(e), autoClose: false });
    } finally {
      setSending(false);
      if (locked) onPackageSent();
    }
  }

  return (
    <Menu withinPortal position="bottom-end" width={300} shadow="md">
      <Menu.Target>
        <Button variant={primary ? 'filled' : 'default'} rightSection={<IconChevronDown size={14} />} loading={sending}>
          {primary ? 'Send package' : 'Deliver'}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {!guard.ok && guard.reason && (
          <Menu.Label>
            <Text size="xs" c="act.8" fw={600}>Locked: {guard.reason}</Text>
          </Menu.Label>
        )}
        {guard.ok && guard.warning && (
          <Menu.Label>
            <Text size="xs" c="watch.8">{guard.warning}</Text>
          </Menu.Label>
        )}
        <Menu.Item leftSection={<IconFileText size={16} />} disabled={!guard.ok} onClick={() => open(urls.html)}>
          Open the web report
        </Menu.Item>
        <Menu.Item leftSection={<IconFileTypePdf size={16} />} disabled={!guard.ok} onClick={() => open(urls.pdf)}>
          Download the PDF
        </Menu.Item>
        <Menu.Item leftSection={<IconPresentation size={16} />} disabled={!guard.ok} onClick={() => download(urls.deck)}>
          Download the meeting deck
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item leftSection={<IconMailForward size={16} />} disabled={!guard.ok || sending} onClick={() => void sendPackage()}>
          <Text size="sm">Send package</Text>
          <Text size="xs" c="dimmed">Locks the quarter, then downloads an Outlook draft with the stored PDF attached.</Text>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
