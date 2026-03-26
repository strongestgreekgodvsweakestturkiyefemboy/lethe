'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from './AuthContext';
import LoginModal from './LoginModal';
import PreferencesModal from './PreferencesModal';

export default function NavBar({ children }: { children?: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex flex-col min-h-screen">
      {/* Top navigation bar */}
      <header className="sticky top-0 z-40 bg-gray-900 border-b border-gray-800 shrink-0">
        <div className="flex items-center h-12 px-4 gap-1">
          {/* Brand */}
          <Link href="/" className="font-bold text-lg tracking-tight text-white mr-4">
            Lethe
          </Link>

          {/* Desktop nav links */}
          <nav className="hidden md:flex items-center gap-1 flex-1">
            <NavLink href="/">Home</NavLink>
            <NavLink href="/creators">Artists</NavLink>
            <NavLink href="/feed">Feed</NavLink>
            <NavLink href="/search">Search</NavLink>
            <NavLink href="/import">Import</NavLink>
          </nav>

          {/* Right side */}
          <div className="hidden md:flex items-center gap-2 ml-auto">
            {user ? (
              <>
                <span className="text-sm text-gray-300">
                  <span className="text-gray-500">@</span>{user.username}
                </span>
                <button
                  onClick={() => setShowPrefs(true)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
                  title="Display preferences"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                <button
                  onClick={logout}
                  className="text-sm text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition-colors"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={() => setShowLogin(true)}
                className="text-sm bg-indigo-600 hover:bg-indigo-500 px-3 py-1 rounded-lg font-medium transition-colors"
              >
                Sign in
              </button>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="md:hidden ml-auto p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>

        {/* Mobile menu */}
        {mobileOpen && (
          <nav className="md:hidden border-t border-gray-800 bg-gray-900 py-2 px-4 flex flex-col gap-1">
            <MobileNavLink href="/" onClick={() => setMobileOpen(false)}>Home</MobileNavLink>
            <MobileNavLink href="/creators" onClick={() => setMobileOpen(false)}>Artists</MobileNavLink>
            <MobileNavLink href="/feed" onClick={() => setMobileOpen(false)}>Feed</MobileNavLink>
            <MobileNavLink href="/search" onClick={() => setMobileOpen(false)}>Search</MobileNavLink>
            <MobileNavLink href="/import" onClick={() => setMobileOpen(false)}>Import</MobileNavLink>
            <div className="border-t border-gray-800 mt-2 pt-2">
              {user ? (
                <>
                  <p className="text-sm text-gray-400 mb-2">@{user.username}</p>
                  <button
                    onClick={() => { setMobileOpen(false); setShowPrefs(true); }}
                    className="w-full text-left text-sm text-gray-300 hover:text-white py-1"
                  >
                    Display Preferences
                  </button>
                  <button
                    onClick={() => { logout(); setMobileOpen(false); }}
                    className="w-full text-left text-sm text-gray-300 hover:text-white py-1"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <button
                  onClick={() => { setMobileOpen(false); setShowLogin(true); }}
                  className="w-full text-left text-sm text-indigo-400 hover:text-indigo-300 py-1 font-medium"
                >
                  Sign in
                </button>
              )}
            </div>
          </nav>
        )}
      </header>

      {/* Page content */}
      <main className="flex-1 min-w-0 overflow-auto">{children}</main>

      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
      {showPrefs && <PreferencesModal onClose={() => setShowPrefs(false)} />}
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
    >
      {children}
    </Link>
  );
}

function MobileNavLink({ href, children, onClick }: { href: string; children: React.ReactNode; onClick: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="py-2 text-sm text-gray-300 hover:text-white transition-colors"
    >
      {children}
    </Link>
  );
}
