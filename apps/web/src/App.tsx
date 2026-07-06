import { useEffect, useState } from 'react';
import {
  AppShell,
  Group,
  NavLink,
  Text,
  ThemeIcon,
  Box,
  Burger,
  Menu,
  Avatar,
  UnstyledButton,
  Badge,
  ActionIcon,
  Indicator,
  Stack,
  Anchor,
  Select,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconLayoutDashboard,
  IconUsers,
  IconPlugConnected,
  IconChartHistogram,
  IconLogout,
  IconClipboardList,
  IconChevronDown,
  IconSettings,
  IconBell,
  IconFileDescription,
  IconCalendarEvent,
  IconAlarm,
} from '@tabler/icons-react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import type { Me, NotificationInfo } from './types.js';

const NAV = [
  { to: '/', label: 'Dashboard', icon: IconLayoutDashboard, match: (p: string) => p === '/' },
  { to: '/clients', label: 'Clients', icon: IconUsers, match: (p: string) => p.startsWith('/clients') },
  { to: '/integrations', label: 'Integrations', icon: IconPlugConnected, match: (p: string) => p.startsWith('/integrations') },
  { to: '/audit', label: 'Audit log', icon: IconClipboardList, match: (p: string) => p.startsWith('/audit') },
  { to: '/settings', label: 'Settings', icon: IconSettings, match: (p: string) => p.startsWith('/settings') },
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

const NOTIF_ICON: Record<string, typeof IconBell> = {
  report: IconFileDescription,
  booking: IconCalendarEvent,
  qbr_due: IconAlarm,
};

/** Header bell: new reports, client bookings, QBRs due for scheduling. */
function NotificationBell() {
  const [items, setItems] = useState<NotificationInfo[]>([]);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .notifications(30)
        .then((r) => {
          if (!live) return;
          setItems(r.notifications);
          setUnread(r.unread);
        })
        .catch(() => undefined);
    };
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);

  async function markAll() {
    try {
      await api.markNotificationsRead('all');
      setItems(items.map((i) => ({ ...i, read: true })));
      setUnread(0);
    } catch {
      // Non-fatal; the next poll retries.
    }
  }

  function open(n: NotificationInfo) {
    if (!n.read) {
      api.markNotificationsRead([n.id]).catch(() => undefined);
      setItems((prev) => prev.map((i) => (i.id === n.id ? { ...i, read: true } : i)));
      setUnread((u) => Math.max(0, u - 1));
    }
    if (n.clientId) navigate(`/clients/${n.clientId}${n.period ? `?period=${n.period}` : ''}`);
  }

  return (
    <Menu withinPortal position="bottom-end" width={360} shadow="md">
      <Menu.Target>
        <Indicator disabled={unread === 0} label={unread > 9 ? '9+' : unread} size={16} color="red" offset={4}>
          <ActionIcon variant="subtle" color="gray" size="lg" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}>
            <IconBell size={20} stroke={1.6} />
          </ActionIcon>
        </Indicator>
      </Menu.Target>
      <Menu.Dropdown>
        <Group justify="space-between" px="sm" py={6}>
          <Text size="sm" fw={600}>Notifications</Text>
          {unread > 0 && (
            <Anchor component="button" type="button" size="xs" onClick={markAll}>
              Mark all read
            </Anchor>
          )}
        </Group>
        <Menu.Divider />
        {items.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            Nothing yet — new reports, client bookings and scheduling reminders land here.
          </Text>
        ) : (
          <Box mah={380} style={{ overflowY: 'auto' }}>
            {items.map((n) => {
              const Icon = NOTIF_ICON[n.kind] ?? IconBell;
              return (
                <Menu.Item key={n.id} onClick={() => open(n)} leftSection={<Icon size={16} stroke={1.6} />}>
                  <Stack gap={2}>
                    <Text size="sm" fw={n.read ? 400 : 700} lineClamp={2}>{n.title}</Text>
                    {n.body && <Text size="xs" c="dimmed" lineClamp={2}>{n.body}</Text>}
                    <Text size="xs" c="dimmed">{new Date(n.at).toLocaleString()}</Text>
                  </Stack>
                </Menu.Item>
              );
            })}
          </Box>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

/** Global client jumper in the header — reflects the client you're viewing and
 *  navigates straight to any other, from anywhere in the app. */
function ClientSwitcher() {
  const [clients, setClients] = useState<Array<{ id: string; name: string; qbrEnabled?: boolean }>>([]);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    api.listClients().then((d) => setClients(d.clients)).catch(() => {});
  }, []);
  const current = pathname.match(/^\/clients\/([^/]+)/)?.[1] ?? null;
  if (clients.length === 0) return null;
  const data = clients
    .filter((c) => c.qbrEnabled !== false || c.id === current)
    .map((c) => ({ value: c.id, label: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <Select
      aria-label="Go to client"
      placeholder="Go to client…"
      searchable
      clearable={false}
      w={240}
      visibleFrom="sm"
      comboboxProps={{ withinPortal: true }}
      leftSection={<IconUsers size={16} stroke={1.6} />}
      data={data}
      value={current}
      onChange={(v) => v && v !== current && navigate(`/clients/${v}`)}
    />
  );
}

function UserMenu() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);
  if (!me) return null;
  return (
    <Menu withinPortal position="bottom-end" width={230}>
      <Menu.Target>
        <UnstyledButton aria-label="Account menu">
          <Group gap={8}>
            <Avatar radius="xl" size={32} color="brand" variant="filled">{initials(me.name)}</Avatar>
            <Box visibleFrom="sm">
              <Group gap={4}>
                <Text size="sm" fw={600} lh={1.1}>{me.name}</Text>
                {me.dev && <Badge size="xs" color="gray" variant="light">dev</Badge>}
              </Group>
              {me.email && <Text size="xs" c="dimmed" lh={1.1}>{me.email}</Text>}
            </Box>
            <IconChevronDown size={14} stroke={1.6} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          {me.name}
          {me.email ? ` · ${me.email}` : ''}
        </Menu.Label>
        <Menu.Item
          component="a"
          href="/.auth/logout?post_logout_redirect_uri=/"
          leftSection={<IconLogout size={14} />}
          disabled={me.dev}
        >
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export function App() {
  const { pathname } = useLocation();
  const [opened, { toggle, close }] = useDisclosure(false);
  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 250, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="md" gap="sm" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <ThemeIcon size={34} radius="md" variant="gradient" gradient={{ from: 'navy.9', to: 'brand.6', deg: 135 }}>
              <IconChartHistogram size={20} />
            </ThemeIcon>
            <Box>
              <Text fw={700} size="lg" lh={1}>
                Mash IT <Text span c="brand.8" fw={700}>QBR</Text>
              </Text>
              <Text size="xs" c="dimmed" lh={1.2}>Your I.T. — Our Priority</Text>
            </Box>
          </Group>
          <Group gap="sm">
            <ClientSwitcher />
            <NotificationBell />
            <UserMenu />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md">
        {NAV.map(({ to, label, icon: Icon, match }) => (
          <NavLink
            key={to}
            component={Link}
            to={to}
            label={label}
            active={match(pathname)}
            leftSection={<Icon size={18} stroke={1.6} />}
            variant="filled"
            mb={4}
            onClick={close}
          />
        ))}
        <Box mt="auto" pt="md">
          <Text size="xs" c="dimmed">Signed in via Microsoft Entra ID</Text>
          <Text size="xs" c="dimmed">Build {__BUILD_INFO__}</Text>
        </Box>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
