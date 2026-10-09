import axios, { AxiosInstance, AxiosError } from 'axios';
import { ApiResponse, DemandForecastResponse, DemoV2RegisterData } from '@/types';
import type { AgentMessageRequest, AgentResponse, AgentConversationList, AgentConversationDetail } from '@/types/agent';

export class AgentApiError extends Error {
  constructor(readonly status?: number, readonly code?: string, readonly conversationId?: string) {
    super('No fue posible consultar el asistente.');
    this.name = 'AgentApiError';
  }
  get retryable() { return this.code !== 'AGENT_HISTORY_PERSISTENCE_FAILED' && (this.status === undefined || this.status === 503 || this.status === 429); }
}

export class DemandForecastApiError extends Error {
  readonly code: 'ML_NOT_READY' | 'ML_SERVICE_UNAVAILABLE';

  constructor(readonly category: 'not-ready' | 'unavailable', readonly status: number) {
    super('Demand forecast request failed');
    this.name = 'DemandForecastApiError';
    this.code = category === 'not-ready' ? 'ML_NOT_READY' : 'ML_SERVICE_UNAVAILABLE';
  }
}

class ApiClient {
  private instance: AxiosInstance;

  constructor() {
    this.instance = axios.create({
      baseURL: process.env.NEXT_PUBLIC_API_URL,
      // Long timeout so a sleeping backend on Render's free tier (which can take
      // 50s+ to spin back up) is not aborted mid cold-start.
      timeout: 90000,
      headers: {
        'Content-Type': 'application/json',
      },
      withCredentials: false,
    });

    this.setupInterceptors();
  }

  private setupInterceptors() {
    // Request interceptor to add auth token
    this.instance.interceptors.request.use(
      (config) => {
        const token = this.getToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling
    this.instance.interceptors.response.use(
      (response) => {
        return response;
      },
      (error: AxiosError) => {
        const status = error.response?.status;
        const requestUrl = error.config?.url || '';
        const isAuthEndpoint =
          requestUrl.includes('/auth/login') || requestUrl.includes('/auth/register');

        // A failed login/register attempt must surface the API error on the page.
        // Forcing a hard redirect here would reload the page and wipe the message
        // (e.g. "Invalid email or password"), so it is skipped for those endpoints.
        if (status === 401 && !isAuthEndpoint) {
          this.removeToken();
          if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Fire-and-forget request to wake up a sleeping backend.
   * Used by AuthProvider on app load so Render's free instance starts spinning up
   * before the user actually submits the login/register form.
   */
  async warmUp(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      await this.instance.get(this.getHealthUrl(), {
        // Never let the warm-up trigger the global 401 redirect logic.
        validateStatus: () => true,
      });
    } catch {
      // Ignore: the server may still be cold-starting, the real request will retry it.
    }
  }

  private getHealthUrl(): string {
    const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
    // The health endpoint lives at the server root, not under the /api prefix.
    return `${baseUrl.replace(/\/api\/?$/, '')}/health`;
  }

  private getToken(): string | null {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('token');
    }
    return null;
  }

  private setToken(token: string): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem('token', token);
    }
  }

  private removeToken(): void {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token');
    }
  }

  // Auth methods
  async login(email: string, password: string): Promise<ApiResponse> {
    const response = await this.instance.post('/auth/login', { email, password });
    if (response.data.success && response.data.data.token) {
      this.setToken(response.data.data.token);
    }
    return response.data;
  }

  async register(name: string, email: string, password: string, businessId: string): Promise<ApiResponse> {
    const response = await this.instance.post('/auth/register', { name, email, password, businessId });
    if (response.data.success && response.data.data.token) {
      this.setToken(response.data.data.token);
    }
    return response.data;
  }

  async registerDemoV2(input: DemoV2RegisterData): Promise<ApiResponse> {
    // Explicit projection: never transport a caller-supplied tenant or role.
    const { name, email, password } = input;
    const response = await this.instance.post('/auth/register-demo-v2', { name, email, password });
    if (response.data.success && response.data.data.token) {
      this.setToken(response.data.data.token);
    }
    return response.data;
  }

  async logout(): Promise<void> {
    try {
      await this.instance.get('/auth/logout');
    } catch (error) {
      // Continue with logout even if API call fails
      console.error(error);
    } finally {
      this.removeToken();
    }
  }

  async getProfile(): Promise<ApiResponse> {
    const response = await this.instance.get('/auth/profile');
    return response.data;
  }

  // Product methods
  async getProducts(params?: {
    search?: string;
    category?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse> {
    const response = await this.instance.get('/products', { params });
    return response.data;
  }

  async getProduct(id: string): Promise<ApiResponse> {
    const response = await this.instance.get(`/products/${id}`);
    return response.data;
  }

  async createProduct(data: any): Promise<ApiResponse> {
    const response = await this.instance.post('/products', data);
    return response.data;
  }

  async updateProduct(id: string, data: any): Promise<ApiResponse> {
    const response = await this.instance.put(`/products/${id}`, data);
    return response.data;
  }

  async updateProductStock(
    id: string,
    data: { quantity: number; operation: 'set' | 'add' | 'subtract' }
  ): Promise<ApiResponse> {
    const response = await this.instance.patch(`/products/${id}/stock`, data);
    return response.data;
  }

  async deleteProduct(id: string): Promise<ApiResponse> {
    const response = await this.instance.delete(`/products/${id}`);
    return response.data;
  }

  async getCategories(): Promise<ApiResponse> {
    const response = await this.instance.get('/products/categories');
    return response.data;
  }

  async getLowStockProducts(): Promise<ApiResponse> {
    const response = await this.instance.get('/products/low-stock');
    return response.data;
  }

  // Contact methods
  async getContacts(params?: {
    search?: string;
    type?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse> {
    const response = await this.instance.get('/contacts', { params });
    return response.data;
  }

  async getContact(id: string): Promise<ApiResponse> {
    const response = await this.instance.get(`/contacts/${id}`);
    return response.data;
  }

  async createContact(data: any): Promise<ApiResponse> {
    const response = await this.instance.post('/contacts', data);
    return response.data;
  }

  async updateContact(id: string, data: any): Promise<ApiResponse> {
    const response = await this.instance.put(`/contacts/${id}`, data);
    return response.data;
  }

  async deleteContact(id: string): Promise<ApiResponse> {
    const response = await this.instance.delete(`/contacts/${id}`);
    return response.data;
  }

  async getCustomers(params?: any): Promise<ApiResponse> {
    const response = await this.instance.get('/contacts/customers', { params });
    return response.data;
  }

  async getVendors(params?: any): Promise<ApiResponse> {
    const response = await this.instance.get('/contacts/vendors', { params });
    return response.data;
  }

  async createCreditPayment(data: {
    customerId: string;
    amount: number;
    currency: 'PEN' | 'USD' | 'EUR';
    paymentMethod: 'cash' | 'card' | 'bank_transfer' | 'wallet';
    notes?: string;
  }): Promise<ApiResponse> {
    const response = await this.instance.post('/credit-payments', data);
    return response.data;
  }

  async getCreditPayments(customerId: string): Promise<ApiResponse> {
    const response = await this.instance.get(`/credit-payments/customer/${customerId}`);
    return response.data;
  }

  // External integrations
  async getExchangeRate(base = 'USD', target = 'PEN'): Promise<ApiResponse> {
    const response = await this.instance.get('/external/exchange-rate', { params: { base, target } });
    return response.data;
  }

  async validateDocument(type: 'dni' | 'ruc' | string, number: string): Promise<ApiResponse> {
    const response = await this.instance.get('/external/document/validate', { params: { type, number } });
    return response.data;
  }

  async validatePaymentMethod(method: string, amount = 0): Promise<ApiResponse> {
    const response = await this.instance.get('/external/payment-method/validate', { params: { method, amount } });
    return response.data;
  }

  async getTelegramStatus(): Promise<ApiResponse> {
    const response = await this.instance.get('/telegram/status');
    return response.data;
  }

  async createTelegramConnectionCode(): Promise<ApiResponse> {
    const response = await this.instance.post('/telegram/connect/code');
    return response.data;
  }

  async disconnectTelegram(): Promise<ApiResponse> {
    const response = await this.instance.delete('/telegram/connection');
    return response.data;
  }

  // Transaction methods
  async getTransactions(params?: {
    type?: string;
    status?: string;
    search?: string;
    contactId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<ApiResponse> {
    const response = await this.instance.get('/transactions', { params });
    return response.data;
  }

  async getTransaction(id: string): Promise<ApiResponse> {
    const response = await this.instance.get(`/transactions/${id}`);
    return response.data;
  }

  async createTransaction(data: any): Promise<ApiResponse> {
    const response = await this.instance.post('/transactions', data);
    return response.data;
  }

  async updateTransactionStatus(id: string, status: 'pending' | 'completed' | 'cancelled'): Promise<ApiResponse> {
    const response = await this.instance.patch(`/transactions/${id}/status`, { status });
    return response.data;
  }

  async getTransactionSummary(params?: any): Promise<ApiResponse> {
    const response = await this.instance.get('/transactions/summary', { params });
    return response.data;
  }

  // Report methods
  async getDashboard(params?: { period?: 'current' | 'latest' }): Promise<ApiResponse> {
    const response = await this.instance.get('/reports/dashboard', { params });
    return response.data;
  }

  async getInventoryReport(params?: any): Promise<ApiResponse> {
    const response = await this.instance.get('/reports/inventory', { params });
    return response.data;
  }

  async getTransactionReport(params?: any): Promise<ApiResponse> {
    const response = await this.instance.get('/reports/transactions', { params });
    return response.data;
  }

  async getCustomerReport(id: string, params?: any): Promise<ApiResponse> {
    const response = await this.instance.get(`/reports/customer/${id}`, { params });
    return response.data;
  }

  async getVendorReport(id: string, params?: any): Promise<ApiResponse> {
    const response = await this.instance.get(`/reports/vendor/${id}`, { params });
    return response.data;
  }

  async getDemandForecast(productId?: string): Promise<ApiResponse<DemandForecastResponse>> {
    try {
      const response = await this.instance.get('/ml/demand-forecast', {
        params: productId ? { productId } : undefined,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const body = error.response?.data as { code?: unknown } | undefined;
        if (status === 409 && body?.code === 'ML_NOT_READY') {
          throw new DemandForecastApiError('not-ready', status);
        }
        if (status === 503 && body?.code === 'ML_SERVICE_UNAVAILABLE') {
          throw new DemandForecastApiError('unavailable', status);
        }
      }
      throw error;
    }
  }

  async sendAgentMessage(input: AgentMessageRequest, requestKey?: string): Promise<ApiResponse<AgentResponse>> {
    try {
      const response = requestKey ? await this.instance.post('/agent/messages', input, { headers: { 'Idempotency-Key': requestKey } })
        : await this.instance.post('/agent/messages', input);
      return response.data;
    } catch (error) {
      const data = axios.isAxiosError(error) ? error.response?.data : undefined;
      const code = typeof data?.code === 'string' && /^AGENT_HISTORY_[A-Z_]+$/.test(data.code) ? data.code : undefined;
      const id = typeof data?.conversationId === 'string' && /^[a-f\d-]{36}$/i.test(data.conversationId) ? data.conversationId : undefined;
      throw new AgentApiError(axios.isAxiosError(error) ? error.response?.status : 500, code, id);
    }
  }
  async listAgentConversations(page = 1): Promise<ApiResponse<AgentConversationList>> {
    try { return (await this.instance.get('/agent/conversations', { params: { page, limit: 10 } })).data; }
    catch (error) { throw new AgentApiError(axios.isAxiosError(error) ? error.response?.status : 500); }
  }
  async decideAgentAction(id: string, conversationId: string, decision: 'confirm' | 'cancel'): Promise<ApiResponse<import('@/types/agent').PendingActionPreview>> {
    try { return (await this.instance.post(`/agent/actions/${encodeURIComponent(id)}/${decision}`, { conversationId })).data; }
    catch { throw new Error('No se pudo confirmar el estado de la acción. Revisa el historial; no envíes una acción nueva.'); }
  }
  async getAgentConversation(id: string, page = 1): Promise<ApiResponse<AgentConversationDetail>> {
    try { return (await this.instance.get(`/agent/conversations/${encodeURIComponent(id)}`, { params: { page, limit: 50 } })).data; }
    catch (error) { throw new AgentApiError(axios.isAxiosError(error) ? error.response?.status : 500); }
  }
  async deleteAgentConversation(id: string): Promise<ApiResponse<{ deleted: boolean }>> {
    try { return (await this.instance.delete(`/agent/conversations/${encodeURIComponent(id)}`)).data; }
    catch (error) { throw new AgentApiError(axios.isAxiosError(error) ? error.response?.status : 500); }
  }
}

export const apiClient = new ApiClient();
export const api = apiClient;
