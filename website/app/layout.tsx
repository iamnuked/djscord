import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "djscord — 서버의 순간을 음악으로",
  description: "장르 플레이리스트와 자동 추천으로 모두의 다음 곡을 이어주는 한국어 Discord 음악 봇.",
  openGraph: {
    title: "djscord — 서버의 순간을 음악으로",
    description: "검색부터 장르 플레이리스트, 자동 추천까지. 대화를 끊지 않는 Discord 음악 봇.",
    type: "website",
  },
  twitter: { card: "summary", title: "djscord", description: "Keep your server together, one track at a time." },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
