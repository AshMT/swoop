import { Outlet, NavLink } from 'react-router-dom';
import Magpie from './Magpie';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/clients', label: 'Clients' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const handleLogout = () => {
    localStorage.removeItem('swoop_token');
    window.location.assign('/login');
  };

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-60 bg-ink text-white flex flex-col shrink-0">
        <div className="px-5 pt-6 pb-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="-rotate-6">
              <Magpie size={46} />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xl font-bold tracking-tight text-white">Swoop</span>
                <span className="text-[10px] bg-white text-ink px-1.5 py-0.5 rounded-md font-bold uppercase tracking-wide">AI</span>
              </div>
              <p className="text-white/40 text-xs mt-0.5">MSP Helpdesk Agent</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-4 py-5 space-y-2">
          {NAV_ITEMS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `block px-3.5 py-2 rounded-xl text-sm font-semibold transition-all ${
                  isActive
                    ? 'bg-white text-ink shadow-sticker-sm -rotate-1'
                    : 'text-white/50 hover:text-white hover:bg-white/10'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="px-4 py-4 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="w-full text-left px-3.5 py-2 text-sm font-medium text-white/40 hover:text-white hover:bg-white/10 rounded-xl transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
