'use client';

// Split-screen container. Members B and C replace the placeholders with
// <StudentView /> and <VendorView /> from ./components once those exist.
// ?role=student or ?role=vendor shows a single view (run each in its own window for the demo).
import { useEffect, useState } from 'react';
import { seedDemo } from '@/lib/store';

type Role = 'both' | 'student' | 'vendor';

function Placeholder({ title, owner }: { title: string; owner: string }) {
  return (
    <div className="flex min-h-[600px] flex-1 items-center justify-center rounded-3xl border-2 border-dashed border-gray-400/50 p-8 text-center">
      <div>
        <p className="text-lg font-semibold">{title}</p>
        <p className="text-sm opacity-60">{owner}</p>
      </div>
    </div>
  );
}

export default function Home() {
  const [role, setRole] = useState<Role>('both');

  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('role');
    if (r === 'student' || r === 'vendor') setRole(r);
    void seedDemo();
  }, []);

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:flex-row md:p-8">
      {role !== 'vendor' && <Placeholder title="StudentView" owner="Member B — app/components/StudentView.tsx" />}
      {role !== 'student' && <Placeholder title="VendorView" owner="Member C — app/components/VendorView.tsx" />}
    </main>
  );
}
