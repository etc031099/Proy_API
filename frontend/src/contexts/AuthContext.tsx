'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { clearActiveConversations } from '@/lib/agentHistory';
import { User, LoginCredentials, RegisterData, DemoV2RegisterData, AuthContextType } from '@/types';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    // Wake a possibly sleeping backend (Render free tier) while the page loads.
    apiClient.warmUp();
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setLoading(false);
        return;
      }

      const response = await apiClient.getProfile();
      if (response.success && response.data) {
        setUser(response.data.user);
      } else {
        localStorage.removeItem('token');
      }
    } catch (error: any) {
      // Only discard the session when the API explicitly rejects the token.
      // Network failures / cold starts must NOT log the user out.
      const status = error?.response?.status;
      if (status === 401 || status === 403) {
        localStorage.removeItem('token');
      } else {
        console.warn('Auth check could not reach the server, keeping session:', error?.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const login = async (credentials: LoginCredentials) => {
    try {
      setError(null);
      setLoading(true);
      
      const response = await apiClient.login(credentials.email, credentials.password);
      
      if (response.success && response.data) {
        setUser(response.data.user);
        router.push('/dashboard');
      } else {
        throw new Error(response.message || 'Login failed');
      }
    } catch (error: any) {
      const message = error.response?.data?.message || error.message || 'Login failed';
      setError(message);
      const loginError = new Error(message) as Error & { code?: string };
      loginError.code = error.response?.data?.code;
      throw loginError;
    } finally {
      setLoading(false);
    }
  };

  const register = async (data: RegisterData) => {
    try {
      setError(null);
      setLoading(true);
      
      const response = await apiClient.register(data.name, data.email, data.password, data.businessId);
      
      if (response.success && response.data) {
        setUser(response.data.user);
        router.push('/dashboard');
      } else {
        throw new Error(response.message || 'Registration failed');
      }
    } catch (error: any) {
      const message = error.response?.data?.message || error.message || 'Registration failed';
      setError(message);
      const registrationError = new Error(message) as Error & { code?: string };
      registrationError.code = error.response?.data?.code;
      throw registrationError;
    } finally {
      setLoading(false);
    }
  };

  const registerDemoV2 = async (data: DemoV2RegisterData) => {
    setError(null);
    setLoading(true);
    try {
      const response = await apiClient.registerDemoV2(data);
      if (!response.success || !response.data?.user) throw new Error('Registro no completado.');
      clearActiveConversations();
      setUser(response.data.user);
      router.push('/dashboard');
    } catch (error: unknown) {
      const failure = error as { response?: { status?: number; data?: { code?: string } } };
      const code = failure.response?.data?.code;
      const message = code === 'BUSINESS_EXISTS' ? 'La cuenta demo V2 ya existe. Inicia sesión con esa cuenta.'
        : code === 'EMAIL_EXISTS' ? 'Ese correo ya tiene una cuenta. Utiliza otro correo para V2.'
        : failure.response?.status === 404 ? 'El registro demo V2 está deshabilitado.'
        : failure.response?.status === 403 ? 'No estás autorizado o el correo no coincide con el configurado.'
        : failure.response?.status === 400 ? 'Revisa el nombre, correo y requisitos de la contraseña.'
        : 'No se pudo crear la cuenta demo V2. Inténtalo más tarde.';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    try {
      await apiClient.logout();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      clearActiveConversations();
      localStorage.removeItem('token');
      router.replace('/login');
      router.refresh();
    }
  };

  const value = {
    user,
    login,
    register,
    registerDemoV2,
    logout,
    loading,
    error,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
