import { useEffect, useState } from 'react';
import { AppShell, Group, NavLink, Text, ThemeIcon, Box, Burger, Menu, Avatar, UnstyledButton, Badge } from '@mantine/core';
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
} from '@tabler/icons-react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { api } from './api.js';
import type { Me } from './types.js';

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
            <Avatar radius="xl" size={32} color="teal" variant="filled">{initials(me.name)}</Avatar>
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
            <ThemeIcon size={34} radius="md" variant="gradient" gradient={{ from: 'navy.9', to: 'teal.7', deg: 135 }}>
              <IconChartHistogram size={20} />
            </ThemeIcon>
            <Box>
              <Text fw={700} size="lg" lh={1}>
                Mash IT <Text span c="teal.7" fw={700}>QBR</Text>
              </Text>
              <Text size="xs" c="dimmed" lh={1.2}>Quarterly Business Reviews</Text>
            </Box>
          </Group>
          <UserMenu />
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
