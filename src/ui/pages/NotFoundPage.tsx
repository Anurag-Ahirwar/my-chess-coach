import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link to="/" className="text-accent underline">
        Go to the start page
      </Link>
    </div>
  );
}
