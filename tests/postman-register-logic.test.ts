import { describe, expect, test } from "bun:test";
import {
  isCaptchaFailureText,
  isOtpFailureText,
  isSignupFailureText,
  isSignupFatalText,
} from "../packages/postman-register/src/selectors/postman";
import { extractCodeFromListText } from "../packages/postman-register/src/steps/verify";

describe("Postman registration text parsing", () => {
  test("extracts labeled verification codes with invisible separators", () => {
    expect(extractCodeFromListText("Verification code: 8​5‌3⁠0﻿2­1")).toBe("853021");
    expect(extractCodeFromListText("您的验证码是 123-456")).toBe("123456");
  });

  test("accepts one unlabeled code but rejects ambiguous inbox text", () => {
    expect(extractCodeFromListText("Postman 654321")).toBe("654321");
    expect(extractCodeFromListText("old 123456 new 654321")).toBeNull();
    expect(extractCodeFromListText("order 12345")).toBeNull();
  });

  test("recognizes CAPTCHA failures without matching ordinary CAPTCHA copy", () => {
    expect(isCaptchaFailureText("Unable to verify the captcha. Please try again.")).toBe(true);
    expect(isCaptchaFailureText("Captcha verification failed due to an error")).toBe(true);
    expect(isCaptchaFailureText("Complete the CAPTCHA to continue")).toBe(false);
  });

  test("recognizes expired or invalid OTP messages", () => {
    expect(isOtpFailureText("The verification code is invalid")).toBe(true);
    expect(isOtpFailureText("验证码已过期，请重新获取")).toBe(true);
    expect(isOtpFailureText("We sent a verification code to your email")).toBe(false);
  });

  test("separates retryable signup errors from fatal account errors", () => {
    expect(isSignupFailureText("Something went wrong.")).toBe(true);
    expect(isSignupFailureText("Something went wrong, please refresh and try again")).toBe(true);
    expect(isSignupFailureText("Your account is ready")).toBe(false);

    expect(isSignupFatalText("This email is already registered")).toBe(true);
    expect(isSignupFatalText("Disposable email addresses are not supported")).toBe(true);
    expect(isSignupFatalText("This username is available")).toBe(false);
  });
});
