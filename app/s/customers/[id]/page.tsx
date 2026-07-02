import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffCustomerClient from "./_components/CustomerClient";

export default async function StaffCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireStaff(1);

  const student = await db.student.findUnique({
    where: { id },
    include: {
      college: true,
      subscription: true,
      orders: { include: { payments: true } },
      compensations: true,
      creditUses: true,
    },
  });

  if (!student) notFound();

  return (
    <div className="screen">
      <TopBar title={student.name} sub={`ID ${student.id}`} back="/s" />
      <StaffCustomerClient student={student} />
    </div>
  );
}
