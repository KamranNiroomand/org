import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Home } from 'lucide-react';
import { useState } from 'react';
import { parseMoney } from '@org/shared';
import { Button, Card, CardHeader, Input, Notice, Select, Textarea } from '../ui';
import { api, type AnalyzePropertyResponse, type Province, type PropertyInput } from '../../lib/api';
import { useSettings } from '../../lib/settings';

/**
 * The property intake form. Every field maps directly onto `PropertyInput`
 * (see `apps/server/src/routes/realestate.ts` for the server-side defaults
 * this mirrors) — left blank, a field falls back to the same default the
 * route would apply, so the form stays short without hiding what's assumed.
 */

interface FormState {
  address: string;
  askingPrice: string;
  propertyType: string;
  beds: string;
  baths: string;
  sqft: string;
  yearBuilt: string;
  hoaFeeMonthly: string;
  estimatedAnnualPropertyTax: string;
  estimatedAnnualInsurance: string;
  downPaymentPct: string;
  mortgageRatePct: string;
  amortizationYears: string;
  expectedMonthlyRent: string;
  marginalTaxRatePct: string;
  province: Province;
  city: string;
  isPrimaryResidence: boolean;
  realtorCommissionPct: string;
  legalFees: string;
  otherClosingCosts: string;
  maintenanceReservePct: string;
  vacancyAllowancePct: string;
  propertyMgmtFeePct: string;
  listingDescription: string;
}

const EMPTY: FormState = {
  address: '',
  askingPrice: '',
  propertyType: 'House',
  beds: '',
  baths: '',
  sqft: '',
  yearBuilt: '',
  hoaFeeMonthly: '',
  estimatedAnnualPropertyTax: '',
  estimatedAnnualInsurance: '',
  downPaymentPct: '20',
  mortgageRatePct: '5.5',
  amortizationYears: '25',
  expectedMonthlyRent: '',
  marginalTaxRatePct: '40',
  province: 'OTHER',
  city: '',
  isPrimaryResidence: true,
  realtorCommissionPct: '5',
  legalFees: '',
  otherClosingCosts: '',
  maintenanceReservePct: '5',
  vacancyAllowancePct: '4',
  propertyMgmtFeePct: '0',
  listingDescription: '',
};

function centsOr(value: string, fallbackCents: number, currency: string): number {
  if (value.trim() === '') return fallbackCents;
  return parseMoney(value, currency)?.cents ?? fallbackCents;
}

function numOr(value: string, fallback: number): number {
  if (value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function intOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function buildPropertyInput(f: FormState, currency: string): PropertyInput {
  return {
    address: f.address.trim(),
    askingPriceCents: centsOr(f.askingPrice, 0, currency),
    propertyType: f.propertyType.trim() || 'House',
    beds: intOrNull(f.beds),
    baths: f.baths.trim() === '' ? null : Number(f.baths),
    sqft: intOrNull(f.sqft),
    yearBuilt: intOrNull(f.yearBuilt),
    hoaFeeCentsMonthly: centsOr(f.hoaFeeMonthly, 0, currency),
    estimatedAnnualPropertyTaxCents: centsOr(f.estimatedAnnualPropertyTax, 0, currency),
    estimatedAnnualInsuranceCents: centsOr(f.estimatedAnnualInsurance, 120_000, currency),
    downPaymentPct: numOr(f.downPaymentPct, 20),
    mortgageRatePct: numOr(f.mortgageRatePct, 5.5),
    amortizationYears: numOr(f.amortizationYears, 25),
    expectedMonthlyRentCents: centsOr(f.expectedMonthlyRent, 0, currency),
    marginalTaxRatePct: numOr(f.marginalTaxRatePct, 40),
    province: f.province,
    city: f.city.trim() || null,
    isPrimaryResidence: f.isPrimaryResidence,
    realtorCommissionPct: numOr(f.realtorCommissionPct, 5),
    legalFeesCents: centsOr(f.legalFees, 150_000, currency),
    otherClosingCostsCents: centsOr(f.otherClosingCosts, 80_000, currency),
    maintenanceReservePct: numOr(f.maintenanceReservePct, 5),
    vacancyAllowancePct: numOr(f.vacancyAllowancePct, 4),
    propertyMgmtFeePct: numOr(f.propertyMgmtFeePct, 0),
    listingDescription: f.listingDescription.trim() || null,
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="text-xs">
      <span className="mb-1 block text-muted">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 text-[11px] font-medium tracking-wide text-muted uppercase">{children}</div>;
}

export function PropertyForm({ onStarted }: { onStarted: (res: AnalyzePropertyResponse) => void }) {
  const { baseCurrency } = useSettings();
  const currency = baseCurrency || 'CAD';
  const [f, setF] = useState<FormState>(EMPTY);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((prev) => ({ ...prev, [key]: value }));

  const submit = useMutation({
    mutationFn: () => api.post<AnalyzePropertyResponse>('/api/realestate/analyze', buildPropertyInput(f, currency)),
    onSuccess: onStarted,
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Analyze a listing"
        subtitle="A location specialist, a rental specialist, and a manager reason through it — with real mortgage and tax math underneath"
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
        className="space-y-5 p-4"
      >
        <div>
          <SectionTitle>Property</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="col-span-2 sm:col-span-2">
              <Field label="Address">
                <Input value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="123 Main St, Toronto, ON" required />
              </Field>
            </div>
            <Field label="Asking price">
              <Input value={f.askingPrice} onChange={(e) => set('askingPrice', e.target.value)} placeholder="850,000" inputMode="decimal" required />
            </Field>
            <Field label="Property type">
              <Select
                value={f.propertyType}
                onChange={(e) => set('propertyType', e.target.value)}
                options={[
                  ['House', 'House'],
                  ['Condo', 'Condo'],
                  ['Townhouse', 'Townhouse'],
                  ['Duplex', 'Duplex'],
                  ['Other', 'Other'],
                ]}
              />
            </Field>
            <Field label="Beds">
              <Input value={f.beds} onChange={(e) => set('beds', e.target.value)} placeholder="3" inputMode="numeric" />
            </Field>
            <Field label="Baths">
              <Input value={f.baths} onChange={(e) => set('baths', e.target.value)} placeholder="2" inputMode="decimal" />
            </Field>
            <Field label="Sqft">
              <Input value={f.sqft} onChange={(e) => set('sqft', e.target.value)} placeholder="1,600" inputMode="numeric" />
            </Field>
            <Field label="Year built">
              <Input value={f.yearBuilt} onChange={(e) => set('yearBuilt', e.target.value)} placeholder="1998" inputMode="numeric" />
            </Field>
          </div>
        </div>

        <div>
          <SectionTitle>Financing</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Down payment %">
              <Input value={f.downPaymentPct} onChange={(e) => set('downPaymentPct', e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Mortgage rate %">
              <Input value={f.mortgageRatePct} onChange={(e) => set('mortgageRatePct', e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Amortization (years)">
              <Input value={f.amortizationYears} onChange={(e) => set('amortizationYears', e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="This will be my primary residence">
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={f.isPrimaryResidence}
                  onChange={(e) => set('isPrimaryResidence', e.target.checked)}
                  className="size-4 accent-accent"
                />
                <span className="text-muted">{f.isPrimaryResidence ? 'Yes — capital gains exempt on sale' : 'No — investment property'}</span>
              </label>
            </Field>
          </div>
        </div>

        <div>
          <SectionTitle>Costs</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Annual property tax">
              <Input value={f.estimatedAnnualPropertyTax} onChange={(e) => set('estimatedAnnualPropertyTax', e.target.value)} placeholder="6,500" inputMode="decimal" required />
            </Field>
            <Field label="Annual insurance" hint="Defaults to $1,200">
              <Input value={f.estimatedAnnualInsurance} onChange={(e) => set('estimatedAnnualInsurance', e.target.value)} placeholder="1,200" inputMode="decimal" />
            </Field>
            <Field label="HOA / condo fee (monthly)">
              <Input value={f.hoaFeeMonthly} onChange={(e) => set('hoaFeeMonthly', e.target.value)} placeholder="0" inputMode="decimal" />
            </Field>
            <Field label="Legal fees (closing)" hint="Defaults to $1,500">
              <Input value={f.legalFees} onChange={(e) => set('legalFees', e.target.value)} placeholder="1,500" inputMode="decimal" />
            </Field>
            <Field label="Other closing costs" hint="Defaults to $800">
              <Input value={f.otherClosingCosts} onChange={(e) => set('otherClosingCosts', e.target.value)} placeholder="800" inputMode="decimal" />
            </Field>
            <Field label="Province">
              <Select
                value={f.province}
                onChange={(e) => set('province', e.target.value as Province)}
                options={[
                  ['OTHER', 'Other / not modeled'],
                  ['ON', 'Ontario'],
                ]}
              />
            </Field>
            <Field label="City" hint="Toronto adds the municipal land transfer tax">
              <Input value={f.city} onChange={(e) => set('city', e.target.value)} placeholder="Toronto" />
            </Field>
            <Field label="Your marginal tax rate %">
              <Input value={f.marginalTaxRatePct} onChange={(e) => set('marginalTaxRatePct', e.target.value)} inputMode="decimal" />
            </Field>
          </div>
        </div>

        <div>
          <SectionTitle>Rental (optional)</SectionTitle>
          <p className="mb-2.5 -mt-1.5 text-[11px] text-faint">
            Leave rent at 0 if this is purely a home to live in. Set it if you'd rent a suite, or might rent the whole property later —
            the rental agent will independently research comparable rents as a cross-check against what you enter here.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Expected monthly rent">
              <Input value={f.expectedMonthlyRent} onChange={(e) => set('expectedMonthlyRent', e.target.value)} placeholder="0" inputMode="decimal" />
            </Field>
            <Field label="Maintenance reserve %">
              <Input value={f.maintenanceReservePct} onChange={(e) => set('maintenanceReservePct', e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Vacancy allowance %">
              <Input value={f.vacancyAllowancePct} onChange={(e) => set('vacancyAllowancePct', e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Property mgmt fee %">
              <Input value={f.propertyMgmtFeePct} onChange={(e) => set('propertyMgmtFeePct', e.target.value)} inputMode="decimal" />
            </Field>
          </div>
        </div>

        <div>
          <SectionTitle>Listing description</SectionTitle>
          <Textarea
            value={f.listingDescription}
            onChange={(e) => set('listingDescription', e.target.value)}
            placeholder="Paste the listing's description here — the agents read it directly for anything the fields above don't capture."
            className="min-h-28"
          />
        </div>

        {submit.isError && (
          <Notice tone="negative" icon={<AlertTriangle className="size-3.5" />}>
            {submit.error instanceof Error ? submit.error.message : 'The request failed.'}
          </Notice>
        )}

        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={submit.isPending || !f.address.trim() || !f.askingPrice.trim()}>
            <Home className="size-3.5" /> Analyze
          </Button>
        </div>
      </form>
    </Card>
  );
}
