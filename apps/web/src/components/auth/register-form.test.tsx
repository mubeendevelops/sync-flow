import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@sync-flow/schemas";
import { RegisterForm } from "./register-form";

const push = vi.fn();
const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));

const signup = vi.fn();
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ signup, user: null, isLoading: false, login: vi.fn(), logout: vi.fn() }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const validValues = {
  displayName: "Ada Lovelace",
  username: "ada_lovelace",
  email: "ada@example.com",
  password: "Str0ng!Passw0rd",
};

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Display name"), validValues.displayName);
  await user.type(screen.getByLabelText("Username"), validValues.username);
  await user.type(screen.getByLabelText("Email"), validValues.email);
  await user.type(screen.getByLabelText("Password"), validValues.password);
}

describe("RegisterForm", () => {
  beforeEach(() => {
    push.mockClear();
    signup.mockClear();
    toastError.mockClear();
  });

  it("shows an inline error on blur for a weak password", async () => {
    const user = userEvent.setup();
    render(<RegisterForm />);

    const passwordInput = screen.getByLabelText("Password");
    await user.type(passwordInput, "weak");
    expect(screen.queryByText(/password/i, { selector: "p" })).not.toBeInTheDocument();

    await user.tab();
    expect(await screen.findByText(/must be at least 10 characters/i)).toBeInTheDocument();
  });

  it("submits valid values and redirects to /documents", async () => {
    signup.mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<RegisterForm />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signup).toHaveBeenCalledWith(validValues));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/documents"));
  });

  it("shows the server's message on a 409 duplicate-email conflict", async () => {
    signup.mockRejectedValueOnce(
      new ApiError({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "Email already in use",
      }),
    );
    const user = userEvent.setup();
    render(<RegisterForm />);

    await fillValidForm(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Email already in use"));
    expect(push).not.toHaveBeenCalled();
  });
});
