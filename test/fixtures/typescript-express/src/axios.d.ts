declare module "axios" {
  export interface AxiosResponse<T = unknown> {
    data: T;
  }

  export interface AxiosInstance {
    get(url: string): Promise<AxiosResponse>;
    post(url: string): Promise<AxiosResponse>;
    put(url: string): Promise<AxiosResponse>;
    patch(url: string): Promise<AxiosResponse>;
    delete(url: string): Promise<AxiosResponse>;
    request(config: { url: string }): Promise<AxiosResponse>;
  }

  const axios: AxiosInstance;
  export default axios;
}
