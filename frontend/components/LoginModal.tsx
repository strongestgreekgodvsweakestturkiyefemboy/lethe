'use client';

import { useState } from 'react';
import { useAuth } from './AuthContext';

const inputClass =
  'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500';

export default function LoginModal({ onClose }: { onClose: () => void }) {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'form' | 'confirm_create'>('form');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await login(username.trim(), password, step === 'confirm_create');
      if (result.error) {
        setError(result.error);
      } else if (result.exists === false) {
        setStep('confirm_create');
      } else {
        onClose();
      }
    } catch {
      setError('Unexpected error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 w-full max-w-sm shadow-2xl">
        <h2 className="text-xl font-bold mb-6 text-white">
          {step === 'confirm_create' ? 'Create new account?' : 'Sign in'}
        </h2>

        {step === 'confirm_create' && (
          <p className="text-sm text-gray-300 mb-4">
            No account found for <strong className="text-white">{username}</strong>.
            Create a new account with this username and password?
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your_username"
              required
              disabled={step === 'confirm_create'}
              autoComplete="username"
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-gray-300">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="current-password"
              className={inputClass}
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-2">
            {step === 'confirm_create' && (
              <button
                type="button"
                onClick={() => { setStep('form'); setError(null); }}
                className="flex-1 border border-gray-700 hover:bg-gray-800 rounded-lg py-2 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg py-2 font-semibold transition-colors"
            >
              {loading
                ? 'Please wait…'
                : step === 'confirm_create'
                ? 'Create Account'
                : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
