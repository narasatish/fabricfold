import type { Metadata } from "next";
import MarketingShell from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "Privacy Policy — FabricFold",
  description:
    "How FabricFold collects, uses, stores and protects your personal data: what we collect, who we share it with, how long we keep it, and your rights under India's DPDP Act.",
  alternates: { canonical: "https://fabricfold.in/privacy" },
};

const UPDATED = "17 July 2026";

export default function Privacy() {
  return (
    <MarketingShell active="/privacy">
      <header className="mx m-sec tight" style={{ textAlign: "center" }}>
        <span className="m-kicker">Legal</span>
        <h1 className="m-h1" style={{ maxWidth: 720, margin: "18px auto 0" }}>Privacy Policy</h1>
        <p className="m-sub" style={{ marginTop: 12 }}>Last updated: {UPDATED}</p>
      </header>

      <section className="m-sec" style={{ paddingTop: 8 }}>
        <div className="mx m-prose">
          <p>
            This policy explains what personal data FabricFold collects when you use our app or website, why we collect
            it, who we share it with, and what control you have over it. It applies to the FabricFold customer app, the
            FabricFold Android app, and fabricfold.in. We are the data fiduciary for this data.
          </p>

          <h2 className="m-h2">What we collect</h2>
          <p>
            <strong>Account details.</strong> Your name, mobile number and the campus or community you belong to. We use
            your mobile number to sign you in with a one-time password (OTP) — we do not store a password for you.
          </p>
          <p>
            <strong>Order data.</strong> The orders you book, the garments and quantities, weight, service type, your
            drop-off slot, order status and timestamps, and your ratings or feedback.
          </p>
          <p>
            <strong>Photos taken at the counter.</strong> When you hand clothes in, our staff may photograph existing
            stains or damage before washing. These photos are kept as a record so that damage disputes can be settled
            fairly for both sides. They are visible only to FabricFold staff.
          </p>
          <p>
            <strong>Payment and billing data.</strong> How much you paid, the method (cash, UPI, wallet credit or
            subscription cycle), invoices and credit notes, and your wallet balance. If you pay online, the payment is
            processed by our payment provider — <strong>your card, UPI PIN and bank credentials never reach
            FabricFold&apos;s systems and we never store them.</strong>
          </p>
          <p>
            <strong>Support messages.</strong> Complaints and any messages you exchange with our staff in the app.
          </p>
          <p>
            <strong>Technical data.</strong> If the app hits an error, we log the error message, the page it happened on
            and your account id so we can fix it. If you allow notifications, we store the push subscription your browser
            or phone gives us. We do not use advertising trackers, and we do not build advertising profiles.
          </p>

          <h2 className="m-h2">Why we use it</h2>
          <p>
            We use your data to run the laundry service you asked for: to take and track your order, tag your garments,
            tell you when it is ready, take payment, issue a valid invoice, honour your subscription, handle complaints
            and refunds, and keep the accounting records Indian tax law requires us to keep. We also use it to detect
            and prevent fraud or misuse of the service, and to fix faults in the app.
          </p>
          <p>
            <strong>We do not sell your personal data, and we do not share it for anyone else&apos;s marketing.</strong>
          </p>

          <h2 className="m-h2">Who we share it with</h2>
          <p>
            We share data only with service providers who help us run FabricFold, and only as far as they need it:
          </p>
          <ul>
            <li><strong>Supabase</strong> — our database, where your account and order records are stored.</li>
            <li><strong>Vercel</strong> — hosting for the app and website.</li>
            <li><strong>Razorpay</strong> — processes online payments, when you choose to pay online.</li>
            <li><strong>SMS and WhatsApp providers</strong> — deliver your login OTP and order updates to your phone.</li>
            <li><strong>Resend</strong> — sends operational email (for example, order and report notifications to the business owner).</li>
            <li><strong>Sentry</strong> — helps us diagnose app errors. Where it records a session, all text and inputs are masked.</li>
          </ul>
          <p>
            We may also disclose data where the law requires it — for example to tax authorities, or in response to a
            valid legal order. If your campus has a billing arrangement with us, we share only what that arrangement
            needs (such as order counts and amounts billed), not your individual garment details or photos.
          </p>
          <p>
            If FabricFold is ever sold, merged or transferred to another business, your data may transfer with it. If
            that happens, this policy continues to apply until you are told otherwise, and we will notify you in the app
            before anything changes.
          </p>

          <h2 className="m-h2">Where your data is stored</h2>
          <p>
            Our database and hosting run on servers located in Australia (Sydney). Your data is therefore transferred
            outside India and stored there. It remains protected by this policy and by contractual terms with those
            providers.
          </p>

          <h2 className="m-h2">How long we keep it</h2>
          <p>
            Invoices, payments and related accounting records are kept for as long as Indian tax law requires — this is
            a legal obligation and we cannot delete them on request. Order history, photos taken at the counter, and
            support messages are kept while your account is active and for a reasonable period afterwards to resolve any
            dispute. We take regular encrypted backups so data can be restored if something fails.
          </p>

          <h2 className="m-h2">How we protect it</h2>
          <p>
            Access is restricted to authorised FabricFold staff, and different staff roles see only what their job needs.
            Traffic is encrypted in transit (HTTPS). Our database enforces row-level security, and financial records
            (invoices, credit notes, payments and the audit log) are written so they cannot be silently altered or
            deleted — including by us. Sensitive actions taken by staff are logged.
          </p>

          <h2 className="m-h2">Your rights</h2>
          <p>
            Under India&apos;s Digital Personal Data Protection Act, 2023, you can ask us to:
          </p>
          <ul>
            <li>tell you what personal data of yours we hold and who we&apos;ve shared it with;</li>
            <li>correct anything that is wrong or incomplete;</li>
            <li>erase data we no longer need (except records the law requires us to keep);</li>
            <li>nominate someone to exercise these rights if you are unable to; and</li>
            <li>raise a grievance if you&apos;re unhappy with how we handled your data.</li>
          </ul>
          <p>
            To do any of these, contact us using the details below. We will respond within a reasonable time. If you are
            not satisfied with our response, you may escalate to the Data Protection Board of India.
          </p>

          <h2 className="m-h2">Notifications</h2>
          <p>
            If you allow them, we send notifications about your own orders — for example when your laundry is ready to
            collect — and occasional service notices from your campus counter. You can turn notifications off at any
            time in your phone or browser settings without losing access to the service.
          </p>

          <h2 className="m-h2">Children</h2>
          <p>
            FabricFold is intended for students and residents aged 18 and over, and we do not knowingly collect data
            from children. If you believe a child&apos;s data has been given to us, contact us and we will remove it.
          </p>

          <h2 className="m-h2">Deleting your account</h2>
          <p>
            You can ask us to delete your account at any time by emailing{" "}
            <a href="mailto:support@fabricfold.in">support@fabricfold.in</a> or messaging us on WhatsApp. We will remove
            your profile, order history, counter photos and support messages, and keep only the invoice and payment
            records that tax law obliges us to retain.
          </p>

          <h2 className="m-h2">Changes to this policy</h2>
          <p>
            If we change how we handle your data, we will update this page and change the &ldquo;last updated&rdquo; date
            above. Significant changes will be notified in the app.
          </p>

          <h2 className="m-h2">Contact us</h2>
          <p>
            For any privacy question, request or grievance:
            <br />
            Email: <a href="mailto:support@fabricfold.in">support@fabricfold.in</a>
            <br />
            WhatsApp / phone: <a href="tel:+918019121966">+91 80191 21966</a>
          </p>
        </div>
      </section>
    </MarketingShell>
  );
}
