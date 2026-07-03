import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  ColorInput,
  FileButton,
  Group,
  Image,
  Loader,
  Center,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconUpload, IconTrash } from '@tabler/icons-react';
import { api } from '../api.js';

const MAX_LOGO_BYTES = 500 * 1024;

/** Read an image file as a data URI (stored inline so reports stay self-contained). */
function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Org-level settings: the Mash IT logo + house colors used as the DEFAULT
 * branding on every deliverable (PDF cover, deck master, report header).
 * Per-client overrides in the workspace Studio still layer on top.
 */
export function Settings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [logo, setLogo] = useState<string | undefined>();
  const [primary, setPrimary] = useState('');
  const [accent, setAccent] = useState('');

  useEffect(() => {
    let live = true;
    api
      .getOrgSettings()
      .then(({ brand }) => {
        if (!live) return;
        setName(brand.name ?? '');
        setLogo(brand.logoDataUri);
        setPrimary(brand.primary ?? '');
        setAccent(brand.accent ?? '');
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  async function pickLogo(file: File | null) {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      notifications.show({ color: 'red', message: 'Keep the logo under 500 KB (PNG/JPEG/SVG).' });
      return;
    }
    try {
      setLogo(await readAsDataUri(file));
    } catch (e) {
      notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Could not read the file.' });
    }
  }

  async function save() {
    setSaving(true);
    try {
      await api.putOrgSettings({ name: name || undefined, logoDataUri: logo, primary: primary || undefined, accent: accent || undefined });
      notifications.show({ color: 'teal', message: 'Branding saved — every report, PDF and deck now carries it.' });
    } catch (e) {
      notifications.show({ color: 'red', title: 'Save failed', message: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Center h={200}>
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap="lg" maw={640}>
      <div>
        <Title order={2}>Settings</Title>
        <Text c="dimmed" size="sm">
          Default branding for every deliverable. Until a logo is uploaded, a built-in Mash IT wordmark is used.
        </Text>
      </div>

      <Card withBorder radius="md" padding="lg">
        <Stack>
          <Text fw={600}>Company logo</Text>
          {logo ? (
            <Image src={logo} alt="Company logo" h={72} w="auto" fit="contain" style={{ alignSelf: 'flex-start' }} />
          ) : (
            <Text size="sm" c="dimmed">No logo uploaded — the built-in wordmark is used on reports.</Text>
          )}
          <Group>
            <FileButton onChange={pickLogo} accept="image/png,image/jpeg,image/svg+xml,image/webp">
              {(props) => (
                <Button {...props} variant="light" leftSection={<IconUpload size={16} />}>
                  {logo ? 'Replace logo' : 'Upload logo'}
                </Button>
              )}
            </FileButton>
            {logo && (
              <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={() => setLogo(undefined)}>
                Remove
              </Button>
            )}
          </Group>

          <TextInput label="Company name on reports" placeholder="Mash IT" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Group grow>
            <ColorInput label="Primary color" placeholder="#0b2545" value={primary} onChange={setPrimary} />
            <ColorInput label="Accent color" placeholder="#1d7874" value={accent} onChange={setAccent} />
          </Group>

          <Group justify="flex-end">
            <Button loading={saving} onClick={save}>Save branding</Button>
          </Group>
        </Stack>
      </Card>
    </Stack>
  );
}
