import { motion } from "framer-motion";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  BarChart3,
  Box,
  Calculator,
  Command,
  PackageSearch,
  Receipt,
  ShieldCheck,
  ShoppingCart,
  Zap,
} from "lucide-react";

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6 } },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Command className="size-5" />
            </div>
            <span className="text-lg font-bold tracking-tight">Forge ERP</span>
          </div>
          <nav className="hidden md:flex gap-6">
            <a href="#features" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Features</a>
            <a href="#modules" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Modules</a>
            <a href="#security" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Security</a>
          </nav>
          <div className="flex items-center gap-4">
            <Link href="/sign-in">
              <Button variant="ghost" className="hidden sm:flex" data-testid="link-sign-in">Sign In</Button>
            </Link>
            <Link href="/sign-up">
              <Button data-testid="link-sign-up">Get Started</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative pt-24 pb-32 md:pt-32 md:pb-40 overflow-hidden">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
          <div className="absolute left-0 right-0 top-0 -z-10 m-auto h-[310px] w-[310px] rounded-full bg-primary/20 opacity-20 blur-[100px]"></div>
          
          <div className="container relative mx-auto px-4 md:px-6">
            <motion.div 
              className="flex flex-col items-center text-center space-y-8"
              initial="hidden"
              animate="visible"
              variants={staggerContainer}
            >
              <motion.div variants={fadeIn} className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                <Zap className="mr-2 size-4" />
                Precision Engineering for Modern Operations
              </motion.div>
              
              <motion.h1 variants={fadeIn} className="max-w-4xl text-5xl font-extrabold tracking-tight sm:text-6xl md:text-7xl lg:text-8xl">
                The Operating System for <span className="text-primary">Physical Business</span>
              </motion.h1>
              
              <motion.p variants={fadeIn} className="max-w-2xl text-xl text-muted-foreground sm:text-2xl">
                Forge ERP connects purchasing, sales, inventory, and finance into a single, high-performance cockpit. Built for mid-market scale, engineered for speed.
              </motion.p>
              
              <motion.div variants={fadeIn} className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
                <Link href="/sign-up">
                  <Button size="lg" className="w-full sm:w-auto h-12 px-8 text-base" data-testid="hero-cta-start">
                    Start Building <ArrowRight className="ml-2 size-4" />
                  </Button>
                </Link>
                <Link href="/sign-in">
                  <Button size="lg" variant="outline" className="w-full sm:w-auto h-12 px-8 text-base" data-testid="hero-cta-demo">
                    Sign In to Dashboard
                  </Button>
                </Link>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Modules Section */}
        <section id="modules" className="py-24 bg-muted/50">
          <div className="container mx-auto px-4 md:px-6">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={fadeIn}
              className="text-center mb-16"
            >
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">Complete Control Across Every Module</h2>
              <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
                Everything you need to run your operations, seamlessly integrated and designed for speed.
              </p>
            </motion.div>

            <motion.div 
              className="grid gap-8 md:grid-cols-2 lg:grid-cols-4"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-50px" }}
              variants={staggerContainer}
            >
              {[
                {
                  title: "Procurement",
                  description: "Streamline purchasing workflows, vendor management, and automated reordering.",
                  icon: ShoppingCart,
                  color: "text-blue-500",
                  bg: "bg-blue-500/10"
                },
                {
                  title: "Sales",
                  description: "Accelerate order-to-cash with fast quote generation and multi-channel order routing.",
                  icon: Receipt,
                  color: "text-green-500",
                  bg: "bg-green-500/10"
                },
                {
                  title: "Inventory",
                  description: "Real-time visibility across multiple warehouses, bin locations, and transit stages.",
                  icon: PackageSearch,
                  color: "text-orange-500",
                  bg: "bg-orange-500/10"
                },
                {
                  title: "Finance",
                  description: "Automated AP/AR matching, comprehensive general ledger, and instant profitability insights.",
                  icon: Calculator,
                  color: "text-purple-500",
                  bg: "bg-purple-500/10"
                }
              ].map((module, i) => (
                <motion.div key={i} variants={fadeIn} className="relative group overflow-hidden rounded-2xl border bg-background p-8 hover:shadow-lg transition-all duration-300">
                  <div className={`inline-flex rounded-xl p-3 ${module.bg} ${module.color} mb-6`}>
                    <module.icon className="size-6" />
                  </div>
                  <h3 className="text-xl font-bold mb-3">{module.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    {module.description}
                  </p>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Feature Highlight Section */}
        <section id="features" className="py-24 overflow-hidden">
          <div className="container mx-auto px-4 md:px-6">
            <div className="grid lg:grid-cols-2 gap-16 items-center">
              <motion.div 
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
                variants={staggerContainer}
                className="space-y-8"
              >
                <motion.div variants={fadeIn}>
                  <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Engineered for the Modern Mid-Market</h2>
                  <p className="mt-4 text-lg text-muted-foreground">
                    We stripped away the bloat of legacy systems to build an interface that respects your time. Forge ERP is dense with information but clean in presentation.
                  </p>
                </motion.div>
                
                <motion.div variants={staggerContainer} className="space-y-6">
                  {[
                    { title: "Lightning Fast Interface", desc: "Built on modern React architecture. No page reloads. Instant feedback." },
                    { title: "Role-Based Workflows", desc: "Every user sees exactly what they need. No more, no less." },
                    { title: "Command Palette", desc: "Navigate anywhere, find any record instantly with keyboard shortcuts." }
                  ].map((feature, i) => (
                    <motion.div key={i} variants={fadeIn} className="flex gap-4">
                      <div className="flex-shrink-0 mt-1">
                        <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <Zap className="size-4" />
                        </div>
                      </div>
                      <div>
                        <h4 className="text-lg font-bold">{feature.title}</h4>
                        <p className="mt-1 text-muted-foreground">{feature.desc}</p>
                      </div>
                    </motion.div>
                  ))}
                </motion.div>
              </motion.div>
              
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                whileInView={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8 }}
                viewport={{ once: true }}
                className="relative mx-auto w-full max-w-[600px] aspect-square lg:aspect-auto lg:h-[600px]"
              >
                <div className="absolute inset-0 bg-gradient-to-tr from-primary/20 to-secondary/20 rounded-3xl transform rotate-3 scale-105 blur-xl"></div>
                <div className="relative h-full w-full rounded-3xl border bg-card p-2 shadow-2xl flex flex-col overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/50">
                    <div className="flex gap-1.5">
                      <div className="size-3 rounded-full bg-red-500/80"></div>
                      <div className="size-3 rounded-full bg-yellow-500/80"></div>
                      <div className="size-3 rounded-full bg-green-500/80"></div>
                    </div>
                    <div className="ml-4 h-5 w-48 rounded bg-background/80 shadow-sm"></div>
                  </div>
                  <div className="flex-1 p-6 flex flex-col gap-4 bg-background">
                    <div className="flex gap-4">
                      <div className="h-24 w-1/3 rounded-xl bg-muted animate-pulse"></div>
                      <div className="h-24 w-1/3 rounded-xl bg-muted animate-pulse delay-75"></div>
                      <div className="h-24 w-1/3 rounded-xl bg-muted animate-pulse delay-150"></div>
                    </div>
                    <div className="h-8 w-1/4 rounded-lg bg-muted mt-4"></div>
                    <div className="flex-1 rounded-xl border bg-card flex flex-col">
                      <div className="h-12 border-b bg-muted/30"></div>
                      <div className="flex-1 p-4 space-y-4">
                        <div className="h-8 w-full rounded bg-muted/50"></div>
                        <div className="h-8 w-full rounded bg-muted/50"></div>
                        <div className="h-8 w-full rounded bg-muted/50"></div>
                        <div className="h-8 w-3/4 rounded bg-muted/50"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        {/* Security Section */}
        <section id="security" className="py-24 bg-primary text-primary-foreground">
          <div className="container mx-auto px-4 md:px-6 text-center">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={fadeIn}
              className="max-w-3xl mx-auto space-y-8"
            >
              <ShieldCheck className="size-16 mx-auto opacity-80" />
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Enterprise-Grade Security by Default</h2>
              <p className="text-xl opacity-90 leading-relaxed">
                Your data is isolated with multi-tenant architecture. Granular permission controls ensure users only access what they need. Complete audit trails for every transaction.
              </p>
            </motion.div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-32">
          <div className="container mx-auto px-4 md:px-6">
            <motion.div 
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={fadeIn}
              className="relative overflow-hidden rounded-3xl bg-card border shadow-xl"
            >
              <div className="absolute inset-0 bg-grid-white/10 bg-[size:20px_20px] [mask-image:linear-gradient(to_bottom,transparent,black)] dark:[mask-image:linear-gradient(to_bottom,transparent,white)]"></div>
              <div className="relative px-6 py-20 sm:px-12 sm:py-24 text-center">
                <h2 className="mx-auto max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
                  Ready to upgrade your operations?
                </h2>
                <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
                  Join hundreds of forward-thinking businesses running on Forge ERP. Get started in minutes.
                </p>
                <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
                  <Link href="/sign-up">
                    <Button size="lg" className="w-full sm:w-auto h-14 px-8 text-lg" data-testid="bottom-cta-start">
                      Start Your Trial
                    </Button>
                  </Link>
                  <Link href="/sign-in">
                    <Button size="lg" variant="secondary" className="w-full sm:w-auto h-14 px-8 text-lg" data-testid="bottom-cta-login">
                      Sign In
                    </Button>
                  </Link>
                </div>
              </div>
            </motion.div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t bg-muted/40 py-12">
        <div className="container mx-auto px-4 md:px-6">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-2">
              <Command className="size-5 text-primary" />
              <span className="font-bold tracking-tight">Forge ERP</span>
            </div>
            <p className="text-sm text-muted-foreground">
              © {new Date().getFullYear()} Forge ERP Inc. All rights reserved.
            </p>
            <div className="flex gap-4">
              <a href="#" className="text-sm text-muted-foreground hover:text-foreground">Terms</a>
              <a href="#" className="text-sm text-muted-foreground hover:text-foreground">Privacy</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
