import type { Page } from "playwright";
import type { TabManager } from "./core/browser";
import type { AccountToken } from "./core/accountToken";

/** 阶段顺序，与执行流程一一对应 */
export const STAGES = ["tempEmail", "signup", "verify", "profile", "upgrade", "team", "enableAi"] as const;
export type Stage = (typeof STAGES)[number];

/**
 * plan_track：贯穿所有阶段的共享状态。
 * 第一阶段写入邮箱，第二阶段写入账号，第三阶段写入验证码，
 * 后续阶段各自读取，互不直接依赖。
 */
export interface PlanTrack {
  /** 第一阶段生成的临时邮箱 */
  email: string | null;
  /** 邮箱 @ 前缀，用作 Postman 用户名 */
  emailPrefix: string | null;
  /** 注册密码（任务固定） */
  password: string;
  /** 注册表单已通过正常的 Register / Create Free Account 提交 */
  signupSubmitted: boolean;
  /** 已在提交后确认显示 OTP 验证 UI；邮箱轮询只能在此状态后开始 */
  verificationReady: boolean;
  /** 邮箱验证码（6 位数字） */
  verifyCode: string | null;
  /** 验证页 URL（含 authFlowId / handover 参数），标签页丢失时用于恢复 */
  verifyUrl: string | null;
  /** 标签页 A：临时邮箱页面 */
  emailTab: Page | null;
  /** 标签页 B：Postman 页面 */
  postmanTab: Page | null;
  /** 当前阶段（用于日志与断点定位） */
  stage: Stage;
  /** 最终阶段收集到的账号凭据，仅在宿主显式接收时回传。 */
  accountToken: AccountToken | null;
}

export function createPlanTrack(password: string): PlanTrack {
  return {
    email: null,
    emailPrefix: null,
    password,
    signupSubmitted: false,
    verificationReady: false,
    verifyCode: null,
    verifyUrl: null,
    emailTab: null,
    postmanTab: null,
    stage: "tempEmail",
    accountToken: null,
  };
}

/** 每个步骤收到的上下文：共享状态 + 标签页管理 */
export interface StepContext {
  plan: PlanTrack;
  tabs: TabManager;
  onToken?: (token: AccountToken) => Promise<void> | void;
}
