'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { 
  LayoutDashboard, 
  Package, 
  Users, 
  Receipt, 
  BarChart3, 
  LogOut, 
  User,
  Menu,
  Globe
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { LanguageSelector } from '@/components/LanguageSelector';

const navigation = [
  { key: 'dashboard', href: '/dashboard', icon: LayoutDashboard },
  { key: 'products', href: '/products', icon: Package },
  { key: 'contacts', href: '/contacts', icon: Users },
  { key: 'transactions', href: '/transactions', icon: Receipt },
  { key: 'reports', href: '/reports', icon: BarChart3 },
  { key: 'integrations', href: '/integrations', icon: Globe },
];

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuth();
  const { t } = useLanguage();
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/90 shadow-sm backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Package className="h-5 w-5" />
            </div>
            <h1 className="text-lg font-bold tracking-tight sm:text-xl">{t('common.appName')}</h1>
          </div>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <ThemeToggle />
            <LanguageSelector />
            {user && (
              <Button
                variant="outline"
                size="sm"
                onClick={logout}
                className="hidden sm:inline-flex"
              >
                <LogOut className="mr-2 h-4 w-4" />
                {t('common.logout')}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                  <User className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56" align="end" forceMount>
                <div className="flex items-center justify-start gap-2 p-2">
                  <div className="flex flex-col space-y-1 leading-none">
                    <p className="font-medium">{user?.name}</p>
                    <p className="w-[200px] truncate text-sm text-muted-foreground">
                      {user?.email}
                    </p>
                  </div>
                </div>
                <DropdownMenuItem onClick={logout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>{t('common.logout')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1600px]">
        {/* Sidebar */}
        <aside className="w-16 shrink-0 border-r bg-muted/20 md:w-64">
          <nav className="sticky top-16 flex flex-col gap-2 p-2 md:p-4">
            {navigation.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
              
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={cn(
                    'flex items-center justify-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors md:justify-start',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                  title={t(`navigation.${item.key}`)}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden md:inline">{t(`navigation.${item.key}`)}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-[1400px]">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}