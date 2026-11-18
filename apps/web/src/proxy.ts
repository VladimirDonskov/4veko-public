import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/signup"];

/**
 * Sends visitors without a session cookie to sign in before any app page
 * renders. The API still checks the session on every request; this only
 * avoids rendering a page that cannot load its data.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  if (request.cookies.has("veko_session")) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" || pathname === "/dashboard" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|monaco/|favicon.ico|.*\\.(?:svg|png|jpg|ico|webp)$).*)"],
};
