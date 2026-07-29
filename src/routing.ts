export function shouldRenderNotebook(pathname: string, isTauriRuntime: boolean): boolean {
  return (
    isTauriRuntime ||
    pathname === '/app' ||
    pathname.startsWith('/app/')
  );
}
