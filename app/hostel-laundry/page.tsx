import type { Metadata } from "next";
import Link from "next/link";
import MarketingShell from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "Hostel & Campus Laundry Service: What to Expect | FabricFold",
  description:
    "How campus and hostel laundry actually works: what a managed on-site counter does, how pricing and subscriptions work, turnaround times, and how to make sure nothing goes missing. A practical guide for students, wardens and colleges in Telangana.",
  alternates: { canonical: "https://fabricfold.in/hostel-laundry" },
};

const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    { "@type": "Question", name: "Is a hostel laundry subscription cheaper than paying per order?", acceptedAnswer: { "@type": "Answer", text: "For most students, yes. If you wash a load or two every week through the term, a per-term plan usually works out cheaper per wash than paying order by order, and you never have to think about paying each time. If you only wash occasionally, pay-per-order is fine and there's no pressure to subscribe." } },
    { "@type": "Question", name: "How do I make sure my clothes don't get mixed up with someone else's?", acceptedAnswer: { "@type": "Answer", text: "Ask whether every garment is individually tagged at drop-off. A good campus laundry tags each piece and logs the count with you, so a missing sock is caught the same day rather than a week later. Avoid setups that pool everyone's clothes into one wash with no tracking." } },
    { "@type": "Question", name: "How long does hostel laundry take?", acceptedAnswer: { "@type": "Answer", text: "A standard wash-and-fold or wash-and-iron order is usually ready in about 48 hours. Same-day express is often available if you need something urgently. Turnaround depends on how busy the counter is around exam time and festival weeks, so plan a little ahead in those periods." } },
    { "@type": "Question", name: "What happens if a garment is damaged or lost?", acceptedAnswer: { "@type": "Answer", text: "A well-run laundry photographs any existing stains or damage at drop-off and compensates you if the fault is genuinely theirs, usually as store credit or a free re-wash. Ask about the compensation policy before you hand over anything valuable, and keep expensive or irreplaceable items out of the wash." } },
  ],
};

export default function HostelLaundry() {
  return (
    <MarketingShell active="">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />

      <header className="mx m-sec tight" style={{ textAlign: "center" }}>
        <span className="m-kicker">A practical guide</span>
        <h1 className="m-h1" style={{ maxWidth: 780, margin: "18px auto 0" }}>Hostel &amp; campus laundry, explained</h1>
        <p className="m-lead center">
          If you live in a hostel or study on a campus, laundry is one of those chores that quietly eats your week. Here&apos;s
          how a managed campus laundry service actually works, what it should cost, and what to check before you trust
          someone with your clothes.
        </p>
      </header>

      <section className="m-sec" style={{ paddingTop: 4 }}>
        <div className="mx m-prose">
          <h2 className="m-h2">The problem with hostel laundry</h2>
          <p>
            Every hostel handles laundry differently, and most of the ways are a compromise. Some students wash by hand in
            a bucket, which is fine for a shirt or two but hopeless for bedsheets and a week&apos;s worth of clothes. Some
            share a coin machine down the corridor that&apos;s always occupied on a Sunday evening. Many hand their clothes
            to an informal dhobi arrangement: a pile of clothes goes out, a scrap of paper with a number comes back, and
            you hope everything returns clean, complete, and roughly when you were told.
          </p>
          <p>
            That last option is the most common on Indian campuses, and it&apos;s also where things go wrong. Clothes go
            missing and there&apos;s no record of what you handed over. The price is a mystery until the end. When a shirt
            comes back with a tear or a colour run, there&apos;s no one to hold accountable, because nothing was written
            down. It works until it doesn&apos;t, and when it doesn&apos;t, you&apos;re out a favourite kurta with no way to
            prove it was ever handed in.
          </p>
          <p>
            A managed campus laundry service is meant to fix exactly that. Instead of an informal handoff, there&apos;s a
            proper counter, a record of every order, and a clear price agreed before any money changes hands. The rest of
            this guide walks through what that looks like in practice, so you know what to expect and what to ask for.
          </p>

          <h2 className="m-h2">What a managed on-site counter actually does</h2>
          <p>
            The core idea is simple: run the laundry on-site, at the hostel or campus itself, with the kind of tracking and
            records that make it dependable. When you drop clothes off, staff count and weigh what&apos;s actually there in
            front of you, rather than guessing later. Each garment gets a tag, so a single sock can be traced back to your
            order. The count is logged against your name, and you get an order number you can check any time.
          </p>
          <p>
            From there, the order moves through clear stages: received at the counter, washing, ready for collection. You
            can see where your clothes are without walking over to ask. When they&apos;re ready, you get a notification and
            a short pickup code. You show the code, the staff verify it against your order, and you collect. That last step
            matters more than it sounds, because verifying a code is what stops someone else from walking off with your
            laundry by mistake.
          </p>
          <p>
            None of this needs an app store download. A good campus laundry runs in your phone&apos;s browser, so you book,
            track and collect from a web page you can add to your home screen. The point is to make the whole thing feel
            less like a chore and more like ordering anything else on your phone.
          </p>

          <h2 className="m-h2">Wash and fold, wash and iron, dry clean: which do you need?</h2>
          <p>
            Most campus laundries offer a few service types, and it helps to know the difference so you don&apos;t overpay
            or under-order.
          </p>
          <ul className="m-check">
            <li><b>Wash and fold</b> is the everyday workhorse: t-shirts, casual wear, towels and bedsheets, washed, dried
              and folded. It&apos;s the cheapest per piece and what most students use week to week.</li>
            <li><b>Wash and iron</b> adds pressing, which matters for shirts, formal trousers and anything you want to look
              crisp for a presentation or an internship interview.</li>
            <li><b>Iron only</b> is for clothes that are already clean but have been sitting crumpled in a suitcase, which
              happens to everyone after a trip home.</li>
            <li><b>Dry clean</b> is for the things a normal wash would ruin: blazers, sarees, woollens, and anything with a
              &quot;dry clean only&quot; label. It costs more because the process is different, so keep it for the items
              that actually need it.</li>
          </ul>
          <p>
            A quick habit that saves money: sort your pile before you drop it off. Putting a single delicate saree through
            wash-and-fold because you couldn&apos;t be bothered to separate it is how garments get damaged, and no
            compensation policy fully makes up for losing something you loved.
          </p>

          <h2 className="m-h2">How pricing works, and why subscriptions exist</h2>
          <p>
            There are two sensible ways to pay for laundry on a campus, and the right one depends on how much you actually
            wash.
          </p>
          <p>
            <b>Pay per order</b> is exactly what it sounds like. You&apos;re charged for what you bring, item by item or by
            weight, and you pay when you collect. It suits students who wash irregularly, or who are only around for part of
            the term. There&apos;s no commitment and nothing to forget.
          </p>
          <p>
            <b>Subscription plans</b> cover a set number of washes over a term or a year for a fixed price. If you do
            laundry every week like clockwork, a plan usually works out cheaper per wash, and you stop thinking about paying
            each time entirely. The trade-off is that unused washes generally don&apos;t roll over once the plan ends, so a
            plan only makes sense if you&apos;ll genuinely use most of it. A good rule of thumb: if you wash at least once a
            week through the term, a plan probably pays for itself; if you wash once a fortnight or less, stay on
            pay-per-order.
          </p>
          <p>
            One thing worth insisting on either way: the price should be shown to you before you commit, and the bill should
            match the count you agreed at the counter. If GST applies, it should appear as a separate line on a proper
            invoice, not folded silently into the total. Being able to see the exact rate card for your own campus, and
            getting a real invoice for what you paid, is the difference between a run business and an informal arrangement.
          </p>

          <h2 className="m-h2">Turnaround: how fast is realistic</h2>
          <p>
            A standard order is usually ready in about 48 hours from the time the counter receives it. That&apos;s a fair
            target for a proper wash, dry and fold, and it&apos;s quick enough that you can run your wardrobe on a simple
            weekly rhythm. When you genuinely need something sooner, same-day express is often available for an extra
            charge, which is worth it the night before an interview and a waste of money the rest of the time.
          </p>
          <p>
            Be realistic around exam weeks and festival periods. Everyone remembers their laundry at the same time, so the
            counter gets busy and turnaround stretches. The fix is boring but effective: drop your clothes a day earlier
            than usual in those weeks, and you&apos;ll never be caught short.
          </p>

          <h2 className="m-h2">Making sure nothing goes missing</h2>
          <p>
            This is the single biggest worry students have, and it&apos;s a fair one. The protection is per-garment
            tagging. When every piece is individually tagged at drop-off and the count is logged with you, a missing item is
            noticed the same day, while it can still be found, rather than a week later when the trail has gone cold.
          </p>
          <p>
            Before you hand over anything you&apos;d be upset to lose, ask two questions. First, is every garment tagged and
            counted at drop-off? Second, what&apos;s the policy if something is damaged or lost? A well-run laundry
            photographs any pre-existing stains or damage when you hand clothes in, so a dispute can be settled fairly for
            both sides, and it has a clear compensation policy written down. The honest answer to &quot;what if you lose my
            shirt&quot; should be a specific one, not a shrug.
          </p>
          <p>
            And a piece of advice no laundry likes to say out loud: don&apos;t give anyone your heirlooms. Wedding wear,
            designer pieces, and anything genuinely irreplaceable should be cleaned by a specialist you&apos;ve chosen
            deliberately, not dropped into a weekly campus wash. Every reputable laundry caps what it will pay for a damaged
            garment, because that&apos;s what keeps the price of a normal wash low, so keep the irreplaceable things out of
            the ordinary pile.
          </p>

          <h2 className="m-h2">For wardens and colleges</h2>
          <p>
            If you run a hostel or manage a campus, laundry is one of those services that generates complaints out of all
            proportion to its size. An informal dhobi arrangement means the institution carries the reputation risk without
            any of the control: when a student loses clothes, they come to the warden, and there&apos;s no record to settle
            it with.
          </p>
          <p>
            A managed laundry vendor changes that equation. You get a real counterparty with accountability, records for
            every order, and a service students can actually track, instead of an informal cash arrangement no one is
            responsible for. The best setups run entirely on-site so there&apos;s no pickup-and-delivery logistics to
            manage, and they give the institution visibility into how the service is running. If that&apos;s something your
            campus needs, our <Link href="/partners">page for colleges and communities</Link> explains how a partnership
            works.
          </p>

          <h2 className="m-h2">How FabricFold does it</h2>
          <p>
            FabricFold runs managed laundry counters on campuses and communities across Telangana. We don&apos;t just wash
            clothes; we run the whole operation on-site, with per-garment tagging, live order tracking, per-campus pricing,
            and a proper invoice for every payment. Students book from their phone, see their own campus&apos;s rates once
            they log in, and collect with a code. Colleges get a dependable vendor with real records instead of an informal
            arrangement.
          </p>
          <p>
            If you&apos;re a student or resident at a campus we already serve, the fastest way to start is to{" "}
            <Link href="/login">log in with your phone number</Link> and pick your campus. If you want to see the mechanics
            first, <Link href="/how-it-works">how it works</Link> walks through the whole thing step by step, and our{" "}
            <Link href="/refunds">refunds and compensation policy</Link> spells out exactly what happens if something goes
            wrong.
          </p>

          <div className="m-panel" style={{ marginTop: 28, textAlign: "center" }}>
            <h3 style={{ margin: 0 }}>Laundry that&apos;s actually tracked</h3>
            <p style={{ fontSize: 15, color: "var(--ink-2)", lineHeight: 1.6, margin: "10px auto 0", maxWidth: 520 }}>
              Book from your room, every garment tagged, collect with a code. See your campus&apos;s rates the moment you
              log in.
            </p>
            <Link href="/login" className="btn mt16" style={{ width: "auto", padding: "0 26px" }}>Log in to get started</Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
