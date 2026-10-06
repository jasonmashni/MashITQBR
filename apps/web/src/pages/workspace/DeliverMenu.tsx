import { useState } from 'react';
import { Button, Menu, Text } from '@mantine/core';
import { IconChevronDown, IconFileText, IconFileTypePdf, IconMailForward, IconPresentation } from '@tabler/icons-react';
import { api, type reportUrls } from '../../api.js';
import { toastError, toastOk } from '../../toast.js';
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

  async function sendPackage() {
    setSending(true);
    try {
      download(urls.email);
      await api.markPackageSent(clientId, period);
      toastOk('Package sent. The email draft is in your downloads; the quarter is stamped as sent.');
      onPackageSent();
    } catch (e) {
      toastError('Could not record the send', e);
    } finally {
      setSending(false);
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
          <Text size="xs" c="dimmed">Downloads an Outlook draft with the PDF attached and marks the package sent.</Text>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
