'use client';

// Role router.
//   /?role=student  laptop: student UI + Bluetooth bridge link (run with `npm run demo`)
//   /?role=vendor   Android phone: full-screen vendor PoS (rear-camera scanner + Web Bluetooth)
//   /               both side by side on one screen (same-device channel; no camera or Bluetooth needed)
//   add &dev=1      to show Member B's VendorSimulator dock
import { useEffect, useState } from 'react';
import { seedDemo } from '@/lib/store';
import { BleBridgeLink } from './components/BleBridgeLink';
import { StudentView } from './components/StudentView';
import { VendorSimulator } from './components/VendorSimulator';
import { VendorView } from './components/VendorView';

type Role = 'both' | 'student' | 'vendor';

export default function Home() {
  const [role, setRole] = useState<Role | null>(null);
  const [dev, setDev] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('role');
    setRole(r === 'student' || r === 'vendor' ? r : 'both');
    setDev(params.get('dev') === '1');
    void seedDemo();
  }, []);

  if (!role) return null;

  if (role === 'vendor') return <VendorView />;

  return (
    <main className="relative mx-auto flex max-w-7xl flex-col items-start gap-6 p-4 md:flex-row md:justify-center md:p-8">
      <StudentView />
      {role === 'both' && <VendorView framed sameDevice />}
      <BleBridgeLink />
      {dev && <VendorSimulator />}
    </main>
  );
}
