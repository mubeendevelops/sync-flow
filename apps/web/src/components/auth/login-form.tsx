"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError, loginBodySchema, type LoginBody } from "@sync-flow/schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useAuth } from "@/hooks/use-auth";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { DEMO_EMAIL, DEMO_PASSWORD } from "@/lib/demo-credentials";

export function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const form = useForm<LoginBody>({
    resolver: zodResolver(loginBodySchema),
    mode: "onBlur",
    defaultValues: { email: "", password: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: LoginBody) {
    try {
      await login(values);
      const target = safeRedirectPath(searchParams.get("redirect")) ?? "/documents";
      router.push(target);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        toast.error("Invalid email or password");
      } else {
        toast.error("Something went wrong. Please try again.");
      }
      // Deliberately not calling form.reset() here — a failed login shouldn't clear the fields.
    }
  }

  function tryDemo() {
    form.setValue("email", DEMO_EMAIL, { shouldValidate: true });
    form.setValue("password", DEMO_PASSWORD, { shouldValidate: true });
    void form.handleSubmit(onSubmit)();
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" autoComplete="email" placeholder="you@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input type="password" autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Sign in
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={tryDemo}
          disabled={isSubmitting}
        >
          Try the demo
        </Button>
      </form>
    </Form>
  );
}
