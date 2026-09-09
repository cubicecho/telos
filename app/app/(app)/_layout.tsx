import { Redirect, Slot } from 'expo-router';
import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/layouts/sidebar';
import { isAuthenticated } from '@/lib/auth';

export default function AppLayout() {
  // The token lives in localStorage, which the first render cannot read on the
  // server or during hydration — so decide after mount rather than redirecting
  // a signed-in user to /login for one frame.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    setSignedIn(isAuthenticated());
  }, []);

  if (signedIn === null) return <div className="min-h-screen bg-background" />;
  if (!signedIn) return <Redirect href="/login" />;

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Slot />
      </main>
    </div>
  );
}
