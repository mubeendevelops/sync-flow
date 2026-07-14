import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@sync-flow/schemas";
import { LoginForm } from "./login-form";

const push = vi.fn();
const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));

const login = vi.fn();
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ login, user: null, isLoading: false, signup: vi.fn(), logout: vi.fn() }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

describe("LoginForm", () => {
  beforeEach(() => {
    push.mockClear();
    login.mockClear();
    toastError.mockClear();
    searchParams.delete("redirect");
  });

  it("shows an inline error on blur for an invalid email, not before", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    const emailInput = screen.getByLabelText("Email");
    expect(screen.queryByText(/invalid/i)).not.toBeInTheDocument();

    await user.type(emailInput, "not-an-email");
    expect(screen.queryByText(/invalid/i)).not.toBeInTheDocument();

    await user.tab();
    expect(await screen.findByText(/invalid/i)).toBeInTheDocument();
  });

  it("submits valid credentials and redirects to /documents by default", async () => {
    login.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "correct-password",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/documents"));
  });

  it("redirects to the ?redirect target on success", async () => {
    searchParams.set("redirect", "/documents/abc-123");
    login.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/documents/abc-123"));
  });

  it("shows a toast and keeps the form filled in when credentials are wrong", async () => {
    login.mockRejectedValueOnce(
      new ApiError({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "Invalid credentials",
      }),
    );
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Invalid email or password"));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("wrong-password");
  });

  it("the demo button fills in the demo credentials and logs in", async () => {
    login.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.click(screen.getByRole("button", { name: "Try the demo" }));

    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({ email: "demo@syncflow.io", password: "demo1234" }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/documents"));
  });
});
