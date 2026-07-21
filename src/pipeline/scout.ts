import { generateText } from "ai";
import { formatActivityLogModelPromptCell } from "../activityLogSheetColumns";
import { parseJsonStringValue } from "../objectLike";
import type { SEOArticleAgent } from "../server";
import { fetchKeywordSuggestions, resolveDataForSeoCreds } from "./dataforseo";
import { errMsg, keywordToSlug } from "./http-utils";
import { getScoutModel } from "./kimi-model";
import { isKimiCurrentlyDegraded } from "../kimiProviderHealth";

interface DiscoveredCategory {
  name: string;
  slug: string;
  estimatedKeywords: number;
  avgPrice: string;
  reasoning: string;
}

/**
 * Hardcoded fallback pool — 100 entries so the scout never exhausts.
 * Ordered roughly by ROI potential (highest first) so the best niches
 * are claimed before rarer long-tail ones.
 */
const CATEGORY_POOL: DiscoveredCategory[] = [
  // ── Tier 1: high AOV, strong buying intent ──────────────────────────────
  {
    name: "Cat Water Fountains",
    slug: "cat-water-fountains",
    estimatedKeywords: 12,
    avgPrice: "$30-$80",
    reasoning: "Smart/stainless steel fountains with high buying intent"
  },
  {
    name: "Cat Trees and Towers",
    slug: "cat-trees-and-towers",
    estimatedKeywords: 15,
    avgPrice: "$100-$400",
    reasoning: "Large/luxury cat furniture with strong Amazon presence"
  },
  {
    name: "Cat Litter Boxes and Systems",
    slug: "cat-litter-boxes-and-systems",
    estimatedKeywords: 14,
    avgPrice: "$30-$600",
    reasoning: "Self-cleaning boxes and top-entry designs"
  },
  {
    name: "Cat Automatic Feeders",
    slug: "cat-automatic-feeders",
    estimatedKeywords: 12,
    avgPrice: "$40-$200",
    reasoning: "Microchip and timed feeders with strong buyer intent"
  },
  {
    name: "Cat Carriers and Strollers",
    slug: "cat-carriers-and-strollers",
    estimatedKeywords: 12,
    avgPrice: "$50-$200",
    reasoning: "Premium travel gear for cats"
  },
  {
    name: "Cat Cameras and Monitors",
    slug: "cat-cameras-and-monitors",
    estimatedKeywords: 10,
    avgPrice: "$30-$200",
    reasoning: "Pet cameras with treat dispensers"
  },
  {
    name: "Cat Climbing Shelves",
    slug: "cat-climbing-shelves",
    estimatedKeywords: 10,
    avgPrice: "$50-$300",
    reasoning: "Wall-mounted climbing systems"
  },
  {
    name: "Cat Litter Furniture",
    slug: "cat-litter-furniture",
    estimatedKeywords: 10,
    avgPrice: "$60-$250",
    reasoning: "Hidden litter box enclosures"
  },
  {
    name: "Cat DNA Test Kits",
    slug: "cat-dna-test-kits",
    estimatedKeywords: 10,
    avgPrice: "$60-$200",
    reasoning: "Breed and health genetic testing"
  },
  // ── Tier 2: mid AOV, consistent demand ──────────────────────────────────
  {
    name: "Cat Scratching Furniture",
    slug: "cat-scratching-furniture",
    estimatedKeywords: 10,
    avgPrice: "$40-$150",
    reasoning: "Designer scratching posts and lounges"
  },
  {
    name: "Cat Beds and Heated Pads",
    slug: "cat-beds-and-heated-pads",
    estimatedKeywords: 12,
    avgPrice: "$30-$120",
    reasoning: "Orthopedic and heated cat beds"
  },
  {
    name: "Cat Window Perches",
    slug: "cat-window-perches",
    estimatedKeywords: 10,
    avgPrice: "$30-$150",
    reasoning: "Mounted shelves and window catios"
  },
  {
    name: "Cat Travel Accessories",
    slug: "cat-travel-accessories",
    estimatedKeywords: 12,
    avgPrice: "$40-$150",
    reasoning: "Airline carriers, car seats, travel bowls"
  },
  {
    name: "Cat Grooming Stations",
    slug: "cat-grooming-stations",
    estimatedKeywords: 10,
    avgPrice: "$30-$100",
    reasoning: "Deshedding tools and bathing stations"
  },
  {
    name: "Cat Harnesses and Leashes",
    slug: "cat-harnesses-and-leashes",
    estimatedKeywords: 10,
    avgPrice: "$20-$60",
    reasoning: "Adventure and walking gear for cats"
  },
  {
    name: "Cat Interactive Toys",
    slug: "cat-interactive-toys",
    estimatedKeywords: 12,
    avgPrice: "$20-$80",
    reasoning: "Puzzle feeders and robotic toys"
  },
  {
    name: "Cat Calming and Pheromone Products",
    slug: "cat-calming-and-pheromone-products",
    estimatedKeywords: 10,
    avgPrice: "$15-$60",
    reasoning: "Diffusers, chews, and travel calming aids"
  },
  {
    name: "Cat Dental Care Supplies",
    slug: "cat-dental-care-supplies",
    estimatedKeywords: 10,
    avgPrice: "$10-$50",
    reasoning: "Toothpaste, brushes, water additives"
  },
  {
    name: "Cat Supplements and Treats",
    slug: "cat-supplements-and-treats",
    estimatedKeywords: 12,
    avgPrice: "$15-$80",
    reasoning: "Hairball, joint, and probiotic SKUs (non-medical claims)"
  },
  // ── Tier 3: strong long-tail keyword surface ─────────────────────────────
  {
    name: "Cat GPS Trackers",
    slug: "cat-gps-trackers",
    estimatedKeywords: 10,
    avgPrice: "$40-$150",
    reasoning: "Subscription-based trackers with recurring revenue signal"
  },
  {
    name: "Cat Enclosures and Catios",
    slug: "cat-enclosures-and-catios",
    estimatedKeywords: 10,
    avgPrice: "$80-$600",
    reasoning: "Outdoor enclosures and tunnel systems"
  },
  {
    name: "Cat Door and Flap Inserts",
    slug: "cat-door-and-flap-inserts",
    estimatedKeywords: 8,
    avgPrice: "$30-$150",
    reasoning: "Microchip and RFID cat doors with installation guides"
  },
  {
    name: "Cat Self-Cleaning Litter Boxes",
    slug: "cat-self-cleaning-litter-boxes",
    estimatedKeywords: 10,
    avgPrice: "$150-$600",
    reasoning: "High-AOV automatic litter robots"
  },
  {
    name: "Cat Stain and Odor Removers",
    slug: "cat-stain-and-odor-removers",
    estimatedKeywords: 10,
    avgPrice: "$10-$40",
    reasoning: "Enzyme cleaners with repeat-purchase intent"
  },
  {
    name: "Cat Anxiety and Stress Relief",
    slug: "cat-anxiety-and-stress-relief",
    estimatedKeywords: 10,
    avgPrice: "$15-$70",
    reasoning: "Thundershirts, pheromone sprays, calming collars"
  },
  {
    name: "Cat Puzzle Feeders and Slow Bowls",
    slug: "cat-puzzle-feeders-and-slow-bowls",
    estimatedKeywords: 8,
    avgPrice: "$15-$50",
    reasoning: "Enrichment feeders with strong vet-recommendation angle"
  },
  {
    name: "Cat Food Storage Containers",
    slug: "cat-food-storage-containers",
    estimatedKeywords: 8,
    avgPrice: "$15-$60",
    reasoning: "Airtight containers and dispensers with freshness angle"
  },
  {
    name: "Cat Collar and ID Tags",
    slug: "cat-collar-and-id-tags",
    estimatedKeywords: 10,
    avgPrice: "$10-$50",
    reasoning: "Breakaway safety collars and custom engraved tags"
  },
  {
    name: "Cat Tunnels and Play Cubes",
    slug: "cat-tunnels-and-play-cubes",
    estimatedKeywords: 8,
    avgPrice: "$15-$50",
    reasoning: "Collapsible tunnels popular for indoor enrichment"
  },
  {
    name: "Cat Litter Mat and Trapper",
    slug: "cat-litter-mat-and-trapper",
    estimatedKeywords: 8,
    avgPrice: "$15-$50",
    reasoning: "Scatter-prevention mats with high repeat-buy rate"
  },
  // ── Tier 4: niche but clear buying intent ────────────────────────────────
  {
    name: "Cat Backpack Carriers",
    slug: "cat-backpack-carriers",
    estimatedKeywords: 8,
    avgPrice: "$40-$120",
    reasoning: "Bubble-window backpacks viral on social media"
  },
  {
    name: "Cat Seat Covers and Car Hammocks",
    slug: "cat-seat-covers-and-car-hammocks",
    estimatedKeywords: 8,
    avgPrice: "$20-$60",
    reasoning: "Car-travel accessories for pet owners"
  },
  {
    name: "Cat Water Bowl and Dish",
    slug: "cat-water-bowl-and-dish",
    estimatedKeywords: 8,
    avgPrice: "$10-$40",
    reasoning: "Ceramic and stainless steel bowls with whisker fatigue angle"
  },
  {
    name: "Cat Nail Clippers and Grinders",
    slug: "cat-nail-clippers-and-grinders",
    estimatedKeywords: 8,
    avgPrice: "$10-$50",
    reasoning: "Grooming tools with vet-approved keyword signal"
  },
  {
    name: "Cat Flea and Tick Collars",
    slug: "cat-flea-and-tick-collars",
    estimatedKeywords: 8,
    avgPrice: "$10-$50",
    reasoning: "Non-prescription preventatives with strong search volume"
  },
  {
    name: "Cat Microchip Scanners",
    slug: "cat-microchip-scanners",
    estimatedKeywords: 7,
    avgPrice: "$30-$100",
    reasoning: "Universal scanners for shelters and concerned owners"
  },
  {
    name: "Cat Plush and Stuffed Toys",
    slug: "cat-plush-and-stuffed-toys",
    estimatedKeywords: 8,
    avgPrice: "$10-$30",
    reasoning: "Catnip-filled plush with gifting angle"
  },
  {
    name: "Cat Heating Pads and Mats",
    slug: "cat-heating-pads-and-mats",
    estimatedKeywords: 8,
    avgPrice: "$20-$80",
    reasoning: "Electric and self-warming pads for senior cats"
  },
  {
    name: "Cat Outdoor Enclosure Tunnels",
    slug: "cat-outdoor-enclosure-tunnels",
    estimatedKeywords: 7,
    avgPrice: "$40-$200",
    reasoning: "Modular outdoor tunnel systems for catio builds"
  },
  {
    name: "Cat Wand and Feather Toys",
    slug: "cat-wand-and-feather-toys",
    estimatedKeywords: 8,
    avgPrice: "$10-$40",
    reasoning: "Interactive wand toys with high engagement and reviews"
  },
  {
    name: "Cat Laser Toys and Pointers",
    slug: "cat-laser-toys-and-pointers",
    estimatedKeywords: 8,
    avgPrice: "$10-$50",
    reasoning: "Automatic laser toys for solo play"
  },
  {
    name: "Cat Catnip Products",
    slug: "cat-catnip-products",
    estimatedKeywords: 8,
    avgPrice: "$8-$30",
    reasoning: "Organic catnip, sprays, and toys with repeat-buy signal"
  },
  {
    name: "Cat Scratching Posts",
    slug: "cat-scratching-posts",
    estimatedKeywords: 10,
    avgPrice: "$20-$80",
    reasoning: "Standalone sisal and cardboard posts"
  },
  {
    name: "Cat Cardboard Scratchers",
    slug: "cat-cardboard-scratchers",
    estimatedKeywords: 8,
    avgPrice: "$10-$30",
    reasoning: "Flat and inclined cardboard scratchers with high review counts"
  },
  // ── Tier 5: emerging and long-tail niches ────────────────────────────────
  {
    name: "Cat Senior Care Products",
    slug: "cat-senior-care-products",
    estimatedKeywords: 8,
    avgPrice: "$20-$80",
    reasoning: "Joint supplements, orthopedic beds, ramps for aging cats"
  },
  {
    name: "Cat Ramps and Steps",
    slug: "cat-ramps-and-steps",
    estimatedKeywords: 8,
    avgPrice: "$25-$100",
    reasoning: "Furniture ramps for senior or mobility-limited cats"
  },
  {
    name: "Cat Feeding Stations",
    slug: "cat-feeding-stations",
    estimatedKeywords: 8,
    avgPrice: "$20-$80",
    reasoning: "Elevated multi-bowl feeding stands"
  },
  {
    name: "Cat Outdoor Run and Playpen",
    slug: "cat-outdoor-run-and-playpen",
    estimatedKeywords: 8,
    avgPrice: "$50-$250",
    reasoning: "Portable outdoor enclosures and exercise pens"
  },
  {
    name: "Cat Grooming Gloves",
    slug: "cat-grooming-gloves",
    estimatedKeywords: 7,
    avgPrice: "$10-$30",
    reasoning: "Deshedding gloves popular for gentle grooming"
  },
  {
    name: "Cat Wipes and Waterless Shampoo",
    slug: "cat-wipes-and-waterless-shampoo",
    estimatedKeywords: 7,
    avgPrice: "$8-$25",
    reasoning: "Grooming wipes for cats that hate baths"
  },
  {
    name: "Cat Eye and Ear Care",
    slug: "cat-eye-and-ear-care",
    estimatedKeywords: 7,
    avgPrice: "$8-$30",
    reasoning: "Ear cleaners and eye wipes with vet-endorsed angle"
  },
  {
    name: "Cat Flea Combs and Tools",
    slug: "cat-flea-combs-and-tools",
    estimatedKeywords: 7,
    avgPrice: "$8-$25",
    reasoning: "Fine-tooth flea combs and treatment accessories"
  },
  {
    name: "Cat Vitamin and Health Chews",
    slug: "cat-vitamin-and-health-chews",
    estimatedKeywords: 8,
    avgPrice: "$15-$50",
    reasoning: "Multivitamin chews with immune and coat support claims"
  },
  {
    name: "Cat Hairball Remedies",
    slug: "cat-hairball-remedies",
    estimatedKeywords: 8,
    avgPrice: "$8-$30",
    reasoning: "Paste, chews, and treats for hairball prevention"
  },
  {
    name: "Cat Urinary Health Products",
    slug: "cat-urinary-health-products",
    estimatedKeywords: 8,
    avgPrice: "$15-$50",
    reasoning: "Supplements and wet food toppers for urinary support"
  },
  {
    name: "Cat Probiotic Supplements",
    slug: "cat-probiotic-supplements",
    estimatedKeywords: 7,
    avgPrice: "$15-$45",
    reasoning: "Digestive probiotic powders and chews"
  },
  {
    name: "Cat Hip and Joint Supplements",
    slug: "cat-hip-and-joint-supplements",
    estimatedKeywords: 7,
    avgPrice: "$15-$50",
    reasoning: "Glucosamine and fish-oil supplements for aging cats"
  },
  {
    name: "Cat Skin and Coat Supplements",
    slug: "cat-skin-and-coat-supplements",
    estimatedKeywords: 7,
    avgPrice: "$12-$40",
    reasoning: "Omega-3 supplements for coat shine and shedding"
  },
  {
    name: "Cat Freeze-Dried Treats",
    slug: "cat-freeze-dried-treats",
    estimatedKeywords: 8,
    avgPrice: "$10-$30",
    reasoning: "Single-ingredient freeze-dried treats with health angle"
  },
  {
    name: "Cat Dental Treats and Chews",
    slug: "cat-dental-treats-and-chews",
    estimatedKeywords: 8,
    avgPrice: "$8-$25",
    reasoning: "VOHC-approved dental chews and greenies-style treats"
  },
  {
    name: "Cat Wet Food Toppers",
    slug: "cat-wet-food-toppers",
    estimatedKeywords: 8,
    avgPrice: "$10-$35",
    reasoning: "Bone broth, gravy toppers, and meal enhancers"
  },
  {
    name: "Cat Raw Food and Freeze-Dried Meals",
    slug: "cat-raw-food-and-freeze-dried-meals",
    estimatedKeywords: 8,
    avgPrice: "$20-$80",
    reasoning: "Raw-diet meals with passionate owner community"
  },
  {
    name: "Cat High-Protein Dry Food",
    slug: "cat-high-protein-dry-food",
    estimatedKeywords: 8,
    avgPrice: "$15-$60",
    reasoning: "Grain-free and high-protein kibble comparison guides"
  },
  {
    name: "Cat Subscription Boxes",
    slug: "cat-subscription-boxes",
    estimatedKeywords: 8,
    avgPrice: "$25-$60",
    reasoning: "Monthly curated toy and treat boxes"
  },
  {
    name: "Cat Birthday and Gift Sets",
    slug: "cat-birthday-and-gift-sets",
    estimatedKeywords: 7,
    avgPrice: "$20-$60",
    reasoning: "Gift-occasion buying intent with low competition"
  },
  {
    name: "Cat Apparel and Costumes",
    slug: "cat-apparel-and-costumes",
    estimatedKeywords: 8,
    avgPrice: "$10-$40",
    reasoning: "Halloween costumes and seasonal apparel"
  },
  {
    name: "Cat Bandanas and Bow Ties",
    slug: "cat-bandanas-and-bow-ties",
    estimatedKeywords: 7,
    avgPrice: "$8-$20",
    reasoning: "Accessories for photogenic cats with gifting intent"
  },
  {
    name: "Cat Portrait and Custom Art",
    slug: "cat-portrait-and-custom-art",
    estimatedKeywords: 7,
    avgPrice: "$20-$100",
    reasoning: "Custom pet portraits and memorial art on Amazon/Etsy"
  },
  {
    name: "Cat Memorial Products",
    slug: "cat-memorial-products",
    estimatedKeywords: 7,
    avgPrice: "$15-$80",
    reasoning: "Urns, memorial stones, and paw-print kits"
  },
  {
    name: "Cat Paw Print Kits",
    slug: "cat-paw-print-kits",
    estimatedKeywords: 7,
    avgPrice: "$10-$40",
    reasoning: "Ink and clay impression kits for keepsakes"
  },
  {
    name: "Cat Microchipping Kits",
    slug: "cat-microchipping-kits",
    estimatedKeywords: 6,
    avgPrice: "$20-$60",
    reasoning: "At-home microchip implant kits and registration guides"
  },
  {
    name: "Cat First Aid Kits",
    slug: "cat-first-aid-kits",
    estimatedKeywords: 7,
    avgPrice: "$15-$50",
    reasoning: "Pet first-aid kits and emergency care supplies"
  },
  {
    name: "Cat Stroller and Pram",
    slug: "cat-stroller-and-pram",
    estimatedKeywords: 8,
    avgPrice: "$60-$200",
    reasoning: "3-wheel and jogging pet strollers"
  },
  {
    name: "Cat Bike Basket and Carrier",
    slug: "cat-bike-basket-and-carrier",
    estimatedKeywords: 7,
    avgPrice: "$30-$100",
    reasoning: "Front and rear bike baskets for pet transport"
  },
  {
    name: "Cat Airline Approved Carriers",
    slug: "cat-airline-approved-carriers",
    estimatedKeywords: 8,
    avgPrice: "$40-$120",
    reasoning: "IATA-compliant soft-sided carriers with high anxiety content"
  },
  {
    name: "Cat Crate and Kennel",
    slug: "cat-crate-and-kennel",
    estimatedKeywords: 8,
    avgPrice: "$30-$150",
    reasoning: "Wire and plastic kennels for vet visits and travel"
  },
  {
    name: "Cat Muzzle and Restraint",
    slug: "cat-muzzle-and-restraint",
    estimatedKeywords: 6,
    avgPrice: "$8-$30",
    reasoning: "Grooming and vet-visit restraint bags and muzzles"
  },
  {
    name: "Cat Screen and Window Guard",
    slug: "cat-screen-and-window-guard",
    estimatedKeywords: 7,
    avgPrice: "$15-$60",
    reasoning: "Safety screens and grilles for cat-proofing windows"
  },
  {
    name: "Cat Proof Trash Can",
    slug: "cat-proof-trash-can",
    estimatedKeywords: 7,
    avgPrice: "$20-$80",
    reasoning: "Pet-proof bins with locking lids"
  },
  {
    name: "Cat Baby Gate and Barrier",
    slug: "cat-baby-gate-and-barrier",
    estimatedKeywords: 7,
    avgPrice: "$25-$80",
    reasoning: "Pet gates with small cat-door cutouts"
  },
  {
    name: "Cat Furniture Protectors",
    slug: "cat-furniture-protectors",
    estimatedKeywords: 8,
    avgPrice: "$10-$40",
    reasoning: "Couch covers and anti-scratch tape for furniture"
  },
  {
    name: "Cat Anti-Scratch Tape and Spray",
    slug: "cat-anti-scratch-tape-and-spray",
    estimatedKeywords: 7,
    avgPrice: "$8-$25",
    reasoning: "Deterrent tapes and repellent sprays"
  },
  {
    name: "Cat Repellent Mats and Mats",
    slug: "cat-repellent-mats",
    estimatedKeywords: 7,
    avgPrice: "$10-$35",
    reasoning: "Scat mats and motion-activated deterrents"
  },
  {
    name: "Cat Indoor Fountain with Filter",
    slug: "cat-indoor-fountain-with-filter",
    estimatedKeywords: 8,
    avgPrice: "$25-$70",
    reasoning: "Filter-replacement angle drives recurring revenue"
  },
  {
    name: "Cat Water Fountain Replacement Parts",
    slug: "cat-water-fountain-replacement-parts",
    estimatedKeywords: 7,
    avgPrice: "$8-$25",
    reasoning: "Filters, pumps, and foam replacements — high repeat buy"
  },
  {
    name: "Cat Smart Home Integration",
    slug: "cat-smart-home-integration",
    estimatedKeywords: 7,
    avgPrice: "$30-$150",
    reasoning: "WiFi feeders, smart doors, and app-connected pet tech"
  },
  {
    name: "Cat Robot Toys",
    slug: "cat-robot-toys",
    estimatedKeywords: 8,
    avgPrice: "$20-$80",
    reasoning: "Automatic rolling and flipping robot toys"
  },
  {
    name: "Cat Electronic Mice Toys",
    slug: "cat-electronic-mice-toys",
    estimatedKeywords: 7,
    avgPrice: "$10-$40",
    reasoning: "Battery-powered mouse toys that mimic prey movement"
  },
  {
    name: "Cat Motorized Feather Toys",
    slug: "cat-motorized-feather-toys",
    estimatedKeywords: 7,
    avgPrice: "$15-$50",
    reasoning: "Spinning and rotating feather wands"
  },
  {
    name: "Cat Kicker and Crinkle Toys",
    slug: "cat-kicker-and-crinkle-toys",
    estimatedKeywords: 7,
    avgPrice: "$8-$25",
    reasoning: "Long kicker toys and crinkle tunnels"
  },
  {
    name: "Cat Mylar Crinkle Balls",
    slug: "cat-mylar-crinkle-balls",
    estimatedKeywords: 6,
    avgPrice: "$5-$15",
    reasoning: "High-volume low-cost impulse toy category"
  },
  {
    name: "Cat Litter Scoop and Holder",
    slug: "cat-litter-scoop-and-holder",
    estimatedKeywords: 7,
    avgPrice: "$8-$30",
    reasoning: "Scoops, holders, and litter waste bags"
  },
  {
    name: "Cat Litter Deodorizer",
    slug: "cat-litter-deodorizer",
    estimatedKeywords: 7,
    avgPrice: "$8-$25",
    reasoning: "Baking soda and enzyme deodorizers for litter boxes"
  },
  {
    name: "Cat Litter Disposal System",
    slug: "cat-litter-disposal-system",
    estimatedKeywords: 7,
    avgPrice: "$20-$50",
    reasoning: "Diaper-Genie-style litter disposal with refill revenue"
  },
  {
    name: "Cat Grass and Wheat Grass Kits",
    slug: "cat-grass-and-wheat-grass-kits",
    estimatedKeywords: 7,
    avgPrice: "$8-$25",
    reasoning: "Grow-your-own cat grass kits for indoor cats"
  },
  {
    name: "Cat Dental Water Additives",
    slug: "cat-dental-water-additives",
    estimatedKeywords: 7,
    avgPrice: "$10-$30",
    reasoning: "No-brush dental care via water bowl additives"
  },
  {
    name: "Cat Enzymatic Digestive Aids",
    slug: "cat-enzymatic-digestive-aids",
    estimatedKeywords: 6,
    avgPrice: "$12-$40",
    reasoning: "Digestive enzyme powders for sensitive stomachs"
  },
  {
    name: "Cat Omega-3 Fish Oil",
    slug: "cat-omega-3-fish-oil",
    estimatedKeywords: 7,
    avgPrice: "$10-$35",
    reasoning: "Fish oil supplements for coat and joint health"
  },
  {
    name: "Cat Weight Management Food",
    slug: "cat-weight-management-food",
    estimatedKeywords: 7,
    avgPrice: "$15-$50",
    reasoning: "Low-calorie and diet formulas for overweight cats"
  },
  {
    name: "Cat Kitten Starter Kits",
    slug: "cat-kitten-starter-kits",
    estimatedKeywords: 8,
    avgPrice: "$30-$100",
    reasoning: "Bundle kits for new kitten owners — high gifting intent"
  },
  {
    name: "Cat Adoption Checklist Products",
    slug: "cat-adoption-checklist-products",
    estimatedKeywords: 7,
    avgPrice: "$20-$80",
    reasoning: "New owner bundles targeting adoption search intent"
  },
  {
    name: "Cat Multi-Cat Household Products",
    slug: "cat-multi-cat-household-products",
    estimatedKeywords: 7,
    avgPrice: "$20-$80",
    reasoning: "Products designed for homes with 2+ cats"
  },
  {
    name: "Cat Indoor Herb Garden",
    slug: "cat-indoor-herb-garden",
    estimatedKeywords: 6,
    avgPrice: "$15-$50",
    reasoning: "Cat-safe herb grow kits including catnip and valerian"
  },
  {
    name: "Cat Travel Water Bottle",
    slug: "cat-travel-water-bottle",
    estimatedKeywords: 7,
    avgPrice: "$12-$35",
    reasoning: "Portable dispensing bottles for on-the-go hydration"
  },
  // ── Tier 5: long-tail combo niches (life-stage × condition × use-case) ──
  // Added after the first ~500 categories exhausted the head/mid pool. Each
  // entry combines AT LEAST TWO specificity axes so they don't collide with
  // existing head-term categories Kimi keeps re-proposing.
  {
    name: "Cat Carriers for International Flights",
    slug: "cat-carriers-for-international-flights",
    estimatedKeywords: 10,
    avgPrice: "$60-$300",
    reasoning:
      "IATA-approved carriers for long-haul travel — high buyer urgency"
  },
  {
    name: "Cat Fountains for Senior Cats with Arthritis",
    slug: "cat-fountains-for-senior-cats-with-arthritis",
    estimatedKeywords: 8,
    avgPrice: "$40-$120",
    reasoning: "Low-step / quiet-pump fountains for arthritic seniors"
  },
  {
    name: "Cat Ramps for Senior Cats with Arthritis",
    slug: "cat-ramps-for-senior-cats-with-arthritis",
    estimatedKeywords: 9,
    avgPrice: "$50-$200",
    reasoning: "Non-slip mobility ramps for arthritic senior cats"
  },
  {
    name: "Cat Puzzle Feeders for Overweight Indoor Cats",
    slug: "cat-puzzle-feeders-for-overweight-indoor-cats",
    estimatedKeywords: 9,
    avgPrice: "$15-$60",
    reasoning: "Slow-feeder puzzle bowls targeting weight management"
  },
  {
    name: "Cat Anti-Anxiety Pheromone Diffusers for Multi-Cat Homes",
    slug: "cat-anti-anxiety-pheromone-diffusers-for-multi-cat-homes",
    estimatedKeywords: 8,
    avgPrice: "$25-$80",
    reasoning: "Calming diffusers tuned for multi-cat conflict reduction"
  },
  {
    name: "Cat Elevated Bowls for Senior Cats",
    slug: "cat-elevated-bowls-for-senior-cats",
    estimatedKeywords: 7,
    avgPrice: "$20-$70",
    reasoning: "Raised bowls for arthritic/megaesophagus senior cats"
  },
  {
    name: "Cat Slow Feeders for Cats That Vomit",
    slug: "cat-slow-feeders-for-cats-that-vomit",
    estimatedKeywords: 8,
    avgPrice: "$10-$40",
    reasoning: "Anti-regurgitation feeders for fast-eating cats"
  },
  {
    name: "Cat Lick Mats for Anxious Cats",
    slug: "cat-lick-mats-for-anxious-cats",
    estimatedKeywords: 7,
    avgPrice: "$8-$25",
    reasoning: "Enrichment lick mats for stress reduction"
  },
  {
    name: "Cat Carrier Backpacks for Hiking",
    slug: "cat-carrier-backpacks-for-hiking",
    estimatedKeywords: 9,
    avgPrice: "$40-$150",
    reasoning: "Ventilated bubble backpacks for outdoor adventures"
  },
  {
    name: "Cat Window Hammocks for Apartment Cats",
    slug: "cat-window-hammocks-for-apartment-cats",
    estimatedKeywords: 7,
    avgPrice: "$15-$60",
    reasoning: "Space-efficient window perches for small spaces"
  },
  {
    name: "Cat Catio Enclosures for Outdoor Time",
    slug: "cat-catio-enclosures-for-outdoor-time",
    estimatedKeywords: 9,
    avgPrice: "$150-$800",
    reasoning: "Outdoor enclosures for safe sunshine access"
  },
  {
    name: "Cat GPS Trackers for Outdoor Cats",
    slug: "cat-gps-trackers-for-outdoor-cats",
    estimatedKeywords: 8,
    avgPrice: "$40-$200",
    reasoning: "Cellular GPS collars for free-roaming cats"
  },
  {
    name: "Cat Escape-Proof Harnesses for Walking",
    slug: "cat-escape-proof-harnesses-for-walking",
    estimatedKeywords: 8,
    avgPrice: "$15-$50",
    reasoning: "Locking harnesses for cats trained to walk on leash"
  },
  {
    name: "Cat Microchip Feeders for Multi-Cat Households",
    slug: "cat-microchip-feeders-for-multi-cat-households",
    estimatedKeywords: 9,
    avgPrice: "$80-$250",
    reasoning: "RFID-gated feeders to separate diets per cat"
  },
  {
    name: "Cat Insulated Carriers for Winter Travel",
    slug: "cat-insulated-carriers-for-winter-travel",
    estimatedKeywords: 6,
    avgPrice: "$40-$130",
    reasoning: "Cold-weather carrier liners and shells"
  },
  {
    name: "Cat Hairball Remedy Gels for Long-Hair Cats",
    slug: "cat-hairball-remedy-gels-for-long-hair-cats",
    estimatedKeywords: 6,
    avgPrice: "$8-$25",
    reasoning: "Daily paste remedies for Persians/Maine Coons"
  },
  {
    name: "Cat Pill Pocket Treats for Picky Cats",
    slug: "cat-pill-pocket-treats-for-picky-cats",
    estimatedKeywords: 6,
    avgPrice: "$5-$20",
    reasoning: "Flavored medication carriers for refusing cats"
  },
  {
    name: "Cat Recovery Suits Post-Surgery",
    slug: "cat-recovery-suits-post-surgery",
    estimatedKeywords: 7,
    avgPrice: "$15-$45",
    reasoning: "Soft alternatives to e-collars after spay/neuter"
  },
  {
    name: "Cat Brushes for Long-Hair Persian Cats",
    slug: "cat-brushes-for-long-hair-persian-cats",
    estimatedKeywords: 7,
    avgPrice: "$10-$40",
    reasoning: "Detangling grooming tools for long-coat breeds"
  },
  {
    name: "Cat Dental Water Additives for Plaque",
    slug: "cat-dental-water-additives-for-plaque",
    estimatedKeywords: 6,
    avgPrice: "$10-$30",
    reasoning: "Drinking-water additives for dental hygiene"
  },
  {
    name: "Cat Calming Beds for Anxious Rescue Cats",
    slug: "cat-calming-beds-for-anxious-rescue-cats",
    estimatedKeywords: 7,
    avgPrice: "$25-$80",
    reasoning: "Donut/cave beds for adopted shelter cats"
  },
  {
    name: "Cat Heated Beds for Senior Outdoor Cats",
    slug: "cat-heated-beds-for-senior-outdoor-cats",
    estimatedKeywords: 7,
    avgPrice: "$30-$100",
    reasoning: "Weatherproof heated shelters for barn / feral cats"
  },
  {
    name: "Cat Slow-Feeder Lick Bowls for Wet Food",
    slug: "cat-slow-feeder-lick-bowls-for-wet-food",
    estimatedKeywords: 6,
    avgPrice: "$8-$25",
    reasoning: "Textured bowls for pâté and gravy slow-feeding"
  },
  {
    name: "Cat Litter Mats for Tracking-Prone Cats",
    slug: "cat-litter-mats-for-tracking-prone-cats",
    estimatedKeywords: 7,
    avgPrice: "$15-$50",
    reasoning: "Trap-mats for high-tracking cats — distinct from litter boxes"
  },
  {
    name: "Cat Wall-Mounted Scratchers for Door Corners",
    slug: "cat-wall-mounted-scratchers-for-door-corners",
    estimatedKeywords: 6,
    avgPrice: "$15-$45",
    reasoning: "Corner-protector scratchers for furniture saving"
  },
  {
    name: "Cat Bath Bags for Squirmy Cats",
    slug: "cat-bath-bags-for-squirmy-cats",
    estimatedKeywords: 6,
    avgPrice: "$10-$30",
    reasoning: "Mesh restraints for safe bathing and grooming"
  },
  {
    name: "Cat Door Inserts for Sliding Glass Doors",
    slug: "cat-door-inserts-for-sliding-glass-doors",
    estimatedKeywords: 7,
    avgPrice: "$50-$300",
    reasoning: "Patio-panel cat door inserts — high install cost / AOV"
  },
  {
    name: "Cat Stroller Mesh Replacement Covers",
    slug: "cat-stroller-mesh-replacement-covers",
    estimatedKeywords: 5,
    avgPrice: "$15-$50",
    reasoning: "Replacement accessories for existing stroller owners"
  },
  {
    name: "Cat Boarding Bedding for Vet Stays",
    slug: "cat-boarding-bedding-for-vet-stays",
    estimatedKeywords: 6,
    avgPrice: "$15-$45",
    reasoning: "Familiar-scent bedding for vet/boarding visits"
  },
  {
    name: "Cat Play Tunnels for Senior Cats",
    slug: "cat-play-tunnels-for-senior-cats",
    estimatedKeywords: 6,
    avgPrice: "$15-$45",
    reasoning: "Low-impact play enrichment for older cats"
  },
  {
    name: "Cat Flea Combs for Dense Coats",
    slug: "cat-flea-combs-for-dense-coats",
    estimatedKeywords: 6,
    avgPrice: "$8-$25",
    reasoning: "Fine-toothed combs for thick double coats"
  },
  {
    name: "Cat Anti-Vibration Carriers for Car Travel",
    slug: "cat-anti-vibration-carriers-for-car-travel",
    estimatedKeywords: 6,
    avgPrice: "$40-$150",
    reasoning: "Padded carriers tuned for motion-sick cats"
  },
  {
    name: "Cat UV Sunshade for Window Perches",
    slug: "cat-uv-sunshade-for-window-perches",
    estimatedKeywords: 5,
    avgPrice: "$15-$40",
    reasoning: "Sun-protection accessories for window-loungers"
  }
];

const SCOUT_EXCLUDED_PROMPT_MAX_CHARS = 3500;
/**
 * Headroom reserved at the end of the truncated excluded-list line for
 * the "... (N slugs total in DB)" tail. Keeps the truncation marker
 * visible inside the MAX_CHARS budget so the prompt doesn't
 * accidentally lose it to the slice boundary.
 */
const SCOUT_TRUNCATION_TAIL_BUFFER_CHARS = 60;

/** Canonical slug for DB + duplicate checks (lowercase kebab). */
function normalizeCategorySlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
}

function truncateExcludedListForPrompt(slugs: string[]): string {
  if (slugs.length === 0) return "none yet";
  const joined = slugs.join(", ");
  if (joined.length <= SCOUT_EXCLUDED_PROMPT_MAX_CHARS) return joined;
  const acc: string[] = [];
  let len = 0;
  for (const s of slugs) {
    const part = acc.length === 0 ? s : `, ${s}`;
    if (
      len + part.length >
      SCOUT_EXCLUDED_PROMPT_MAX_CHARS - SCOUT_TRUNCATION_TAIL_BUFFER_CHARS
    )
      break;
    acc.push(s);
    len += part.length;
  }
  return `${acc.join(", ")} ... (${slugs.length} slugs total in DB—never reuse any existing slug)`;
}

function clampEstimatedKeywords(n: unknown): number {
  if (typeof n === "number" && Number.isFinite(n)) {
    return Math.min(50, Math.max(5, Math.round(n)));
  }
  return 12;
}

function asDiscoveredCategory(o: {
  name: string;
  slug: string;
  estimatedKeywords?: unknown;
  avgPrice?: unknown;
  reasoning?: unknown;
}): DiscoveredCategory {
  const slug = normalizeCategorySlug(o.slug);
  return {
    name: o.name.trim(),
    slug,
    estimatedKeywords: clampEstimatedKeywords(o.estimatedKeywords),
    avgPrice: typeof o.avgPrice === "string" ? o.avgPrice : "",
    reasoning: typeof o.reasoning === "string" ? o.reasoning : ""
  };
}

function parseScoutRoiResponse(text: string): {
  candidates: DiscoveredCategory[];
  scores: number[];
} | null {
  const raw = parseJsonStringValue(text);
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const slugRaw = typeof o.slug === "string" ? o.slug.trim() : "";
  const candidates: DiscoveredCategory[] = [];
  const scores: number[] = [];
  if (name && slugRaw) {
    candidates.push(
      asDiscoveredCategory({
        name,
        slug: slugRaw,
        estimatedKeywords: o.estimatedKeywords,
        avgPrice: o.avgPrice,
        reasoning: o.reasoning
      })
    );
    scores.push(
      typeof o.categoryRoiScore === "number" &&
        Number.isFinite(o.categoryRoiScore)
        ? o.categoryRoiScore
        : 1000
    );
  }
  const alts = o.alternates;
  if (Array.isArray(alts)) {
    for (const item of alts) {
      if (!item || typeof item !== "object") continue;
      const ar = item as Record<string, unknown>;
      const n = typeof ar.name === "string" ? ar.name.trim() : "";
      const slRaw = typeof ar.slug === "string" ? ar.slug.trim() : "";
      if (!n || !slRaw) continue;
      candidates.push(
        asDiscoveredCategory({
          name: n,
          slug: slRaw,
          estimatedKeywords: ar.estimatedKeywords,
          avgPrice: ar.avgPrice,
          reasoning: ar.reasoning
        })
      );
      scores.push(
        typeof ar.categoryRoiScore === "number" &&
          Number.isFinite(ar.categoryRoiScore)
          ? ar.categoryRoiScore
          : 0
      );
    }
  }
  if (candidates.length === 0) return null;
  return { candidates, scores };
}

function pickFirstUnusedCategory(
  candidates: DiscoveredCategory[],
  scores: number[],
  excludedNorm: Set<string>
): DiscoveredCategory | null {
  const indexed = candidates.map((cat, i) => ({
    cat,
    score: scores[i] ?? 0,
    idx: i
  }));
  indexed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  for (const { cat } of indexed) {
    const key = normalizeCategorySlug(cat.slug);
    if (key && !excludedNorm.has(key)) return cat;
  }
  return null;
}

function buildScoutRoiPrompt(
  excludedList: string,
  excludedCount: number
): string {
  return `You scout the next HIGH-ROI Amazon affiliate **category niche** for catsluvus.com (cat products only).

North star: maximize **expected commission per 1,000 visitors** via a niche with strong **AOV × Associates commission band × buyer-intent keyword surface**, without medical/vet treatment claims.

ALREADY IN DATABASE (${excludedCount} slugs; do not repeat any slug): ${excludedList}

🚫 BANNED HEAD TERMS — DO NOT propose any variant of these saturated categories; we already have 500+ of them:
- cat trees / cat towers / cat scratchers / cat scratching posts
- cat litter / cat litter boxes / cat litter mats
- cat water fountains / cat bowls / cat feeders
- cat beds / cat blankets / cat pillows
- cat toys (generic) / cat balls / cat mice / cat wand toys
- cat carriers (generic) / cat strollers (generic)
- cat cameras (generic) / cat collars (generic)
- cat food (generic) / cat treats (generic)

✅ PUSH HARD into the LONG TAIL. Good candidates combine TWO OR MORE specificity axes:
- Life-stage axis: kittens / senior cats / adult-only / nursing queens
- Condition axis: arthritis / hyperthyroid / diabetic / overweight / sensitive stomach / hairball-prone / post-surgery / blind / deaf / FIV+ / urinary-tract-prone
- Use-case axis: international flights / road trips / IATA-approved travel / camping / RV living / apartments / multi-cat households / catio outdoor / move-day calming
- Setting axis: small apartments / large homes / wall-mounted / corner-fitting / hidden / luxury-modern / minimalist / Scandinavian-style

✅ EXAMPLES of GOOD long-tail picks (these specific slugs are claimed; emulate the SHAPE):
- \`cat-carriers-for-international-flights\` (carrier × international travel)
- \`cat-fountains-for-senior-cats-with-arthritis\` (fountain × senior + arthritis)
- \`cat-puzzle-feeders-for-overweight-indoor-cats\` (feeder × overweight + indoor)
- \`cat-anti-anxiety-pheromone-diffusers-for-multi-cat-homes\` (calming × multi-cat household)
- \`cat-ramps-for-senior-cats-with-arthritis\` (mobility × senior + arthritis)

🚫 BAD examples (too generic; will collide with DB):
- \`cat-toys\` (head term — banned)
- \`cat-beds-for-cats\` (no specificity axis added)
- \`cat-products\` (not a niche at all)

Score each candidate axis 0–10 (decimals ok):
- R RevenuePotential: typical ASP + commission intent
- D DemandClarity: distinct buyer-intent keyword families (best/for/under/review/vs/affordable)
- C CompetitionPressure: room for independents vs only megasites — LONG-TAIL SCORES HIGHER HERE
- M ContentMoat: comparison tables, safety/fit/material depth for cats
- F OpsFriction: penalize claims risk, heavy returns, regulatory traps

CategoryROI_score = 0.25*R + 0.25*D + 0.15*C + 0.20*M + 0.15*F

RULES:
1. Slug MUST be kebab-case, start with "cat-", lowercase, ASCII letters/hyphens only.
2. Slug MUST be at least 4 segments long (e.g. \`cat-carrier-international-flights\`) — short slugs are head terms in disguise.
3. Cat-related Amazon-shoppable products; avoid human-only categories.
4. estimatedKeywords between 5 and 50 (distinct buyer intents you could write).
5. Provide ONE primary pick plus up to 8 alternates with UNIQUE slugs (we pick first not in DB).
6. NEVER duplicate a slug in ALREADY IN DATABASE or across primary/alternates.
7. NEVER use any of the BANNED HEAD TERMS above as a primary keyword.
8. Return ONLY valid JSON, no markdown.

Return ONLY this shape:
{"name":"Category Name","slug":"cat-example-slug","estimatedKeywords":12,"avgPrice":"$30-$200","reasoning":"one line","categoryRoiScore":7.5,"roiBreakdown":{"R":8,"D":7,"C":6,"M":8,"F":7},"alternates":[{"name":"Alt","slug":"cat-alt-slug","estimatedKeywords":10,"avgPrice":"$40-$150","reasoning":"...","categoryRoiScore":6.2}]}`;
}

/**
 * Slug-variant suffixes used when the base pool is exhausted.
 * Each base slug is combined with each suffix to create new unique slugs.
 */
const POOL_VARIANT_SUFFIXES = [
  "-guide",
  "-reviews",
  "-buying-guide",
  "-for-beginners",
  "-comparison"
];

/**
 * Stub keywords inserted when generateKeywords returns 0 rows.
 * Prevents saveCategory from deleting the category so the pipeline
 * can always proceed — the stub row will be overwritten on the next cycle.
 */
function insertStubKeyword(
  agent: SEOArticleAgent,
  categorySlug: string,
  categoryName: string
): void {
  const kw = `best ${categoryName.toLowerCase()}`;
  // Slug + id derivation matches expandWithKeywordSuggestions below
  // (scout.ts ~line 1235) so stub rows are shaped identically to
  // DataForSEO-sourced rows. id is the (categorySlug:slug) PK; both
  // it and `slug` are NOT NULL on the keywords table.
  const slug = keywordToSlug(kw);
  const id = `${categorySlug}:${slug}`;
  try {
    // Columns must match the schema declared in src/server.ts onStart()
    // (CREATE TABLE keywords + ALTER migrations). Previously used
    // non-existent columns `difficulty` and `buyer_intent_score` which
    // caused every fallback insert to throw — see corrected names
    // `keyword_difficulty` and the omission of buyer_intent_score.
    agent.sql`INSERT OR IGNORE INTO keywords
      (id, category_slug, keyword, slug, status, search_volume, keyword_difficulty, cpc)
      VALUES (${id}, ${categorySlug}, ${kw}, ${slug}, 'pending', 0, 0, 0)`;
    agent.log(
      "warning",
      `Scout: inserted stub keyword "${kw}" for "${categorySlug}" because generateKeywords returned 0 rows`,
      "legacyScout",
      { categorySlug, kanbanStage: "debug" }
    );
  } catch (stubErr: unknown) {
    agent.log(
      "error",
      `Scout: stub keyword insert also failed for "${categorySlug}": ${errMsg(stubErr)}`,
      "legacyScout",
      { categorySlug, kanbanStage: "debug" }
    );
  }
}

/**
 * Tier 0 — DataForSEO Labs scout.
 *
 * Uses the existing `fetchKeywordSuggestions` integration (already wired
 * for keyword-metrics hydration) to expand a rotating seed keyword into
 * 50 long-tail suggestions with REAL Google demand data: monthly search
 * volume, CPC (commercial-intent proxy), and keyword difficulty (0-100).
 *
 * Seed rotation: we cycle through SEEDS by (excludedCount % SEEDS.length),
 * so over the catalog's lifetime each facet ("best cat", "cat for", "cats
 * with", etc.) gets equal exposure. This avoids monoculture — calling
 * `fetchKeywordSuggestions("cat")` repeatedly returns the same shape of
 * head-term suggestions every time.
 *
 * Filtering:
 *  - `searchVolume >= 30`  — drops zero-demand suggestions
 *  - `cpc > 0`             — drops non-commercial (informational) terms
 *  - `keywordDifficulty <= 70` — drops domain-saturated heads
 *  - slug not already in DB
 *  - slug at least 4 hyphen-segments long — drops head-term collisions
 *    (an extra guard since seeds like "best cat" can still yield short
 *    expansions like "cat litter")
 *
 * Returns null on any failure (missing creds, API down, no usable
 * suggestions). Caller falls through to Tier 1 silently.
 */
/**
 * KV key used to short-circuit Tier 0 after a hard rate-limit / quota
 * error. Stored with a 30-min TTL so the scout backs off automatically;
 * after expiry the next cycle retries. Avoids hammering a known-dead
 * provider every 5-min autonomous-loop tick.
 */
const DATAFORSEO_BACKOFF_KEY = "scout-dataforseo-tier0-backoff";
const DATAFORSEO_BACKOFF_TTL_SECONDS = 30 * 60;

async function scoutFromDataForSeo(
  agent: SEOArticleAgent,
  excludedNorm: Set<string>
): Promise<DiscoveredCategory | null> {
  const { creds } = resolveDataForSeoCreds(
    agent.envBindings.DATAFORSEO_LOGIN,
    agent.envBindings.DATAFORSEO_PASSWORD
  );
  if (!creds) return null;

  // Backoff check: if a recent call returned 402 / quota / auth failure,
  // skip Tier 0 entirely until the TTL expires. Falls through to Tier 1
  // AI scout immediately so the autonomous loop keeps moving.
  try {
    const backedOff = await agent.envBindings.ARTICLES_KV.get(
      DATAFORSEO_BACKOFF_KEY
    );
    if (backedOff) {
      agent.log(
        "info",
        `Scout DataForSEO: skipping Tier 0 (recent 402/quota backoff active; until ${backedOff})`,
        "legacyScout",
        { kanbanStage: "planning" }
      );
      return null;
    }
  } catch {
    /* fall through; backoff check is best-effort */
  }

  // Seeds explore different long-tail facets. Rotating by the existing
  // category count distributes coverage across the catalog's lifetime
  // without needing extra KV state. New seeds can be appended without
  // disturbing past rotation order.
  const SEEDS = [
    "best cat",
    "cat for",
    "cats with",
    "cat carrier",
    "cat fountain",
    "cat ramp",
    "cat puzzle",
    "cat calming",
    "cat senior",
    "cat travel"
  ];
  const seed = SEEDS[excludedNorm.size % SEEDS.length];

  const result = await fetchKeywordSuggestions(creds, seed, { limit: 50 });
  if ("error" in result) {
    // If the error is a hard quota/auth signal (HTTP 402 / 401 / 403),
    // record a backoff so subsequent ticks skip Tier 0 for 30 min.
    const isHardLimit = /HTTP\s*40[123]\b|quota|credit/i.test(result.error);
    if (isHardLimit) {
      try {
        const until = new Date(
          Date.now() + DATAFORSEO_BACKOFF_TTL_SECONDS * 1000
        ).toISOString();
        await agent.envBindings.ARTICLES_KV.put(DATAFORSEO_BACKOFF_KEY, until, {
          expirationTtl: DATAFORSEO_BACKOFF_TTL_SECONDS
        });
      } catch {
        /* best-effort */
      }
    }
    agent.log(
      "warning",
      `Scout DataForSEO: fetchKeywordSuggestions("${seed}") failed: ${result.error} — falling through to AI scout${isHardLimit ? " (30-min backoff set)" : ""}`,
      "legacyScout",
      { kanbanStage: "planning" }
    );
    return null;
  }
  if (result.suggestions.length === 0) {
    agent.log(
      "info",
      `Scout DataForSEO: fetchKeywordSuggestions("${seed}") returned 0 suggestions — falling through`,
      "legacyScout",
      { kanbanStage: "planning" }
    );
    return null;
  }

  const MIN_VOLUME = 30;
  const MAX_DIFFICULTY = 70;
  const MIN_SLUG_SEGMENTS = 4;

  // Sort by search volume desc so highest-demand suggestions get first crack.
  const ranked = [...result.suggestions].sort(
    (a, b) => b.searchVolume - a.searchVolume
  );
  for (const s of ranked) {
    if (s.searchVolume < MIN_VOLUME) continue;
    if (s.cpc <= 0) continue;
    if (s.keywordDifficulty > MAX_DIFFICULTY) continue;
    let slug = keywordToSlug(s.keyword);
    if (!slug) continue;
    if (!slug.startsWith("cat-") && !slug.startsWith("cats-")) {
      slug = `cat-${slug}`;
    }
    const normalized = normalizeCategorySlug(slug);
    if (!normalized) continue;
    if (normalized.split("-").length < MIN_SLUG_SEGMENTS) continue;
    if (excludedNorm.has(normalized)) continue;

    const name = s.keyword
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    const candidate: DiscoveredCategory = {
      name,
      slug: normalized,
      estimatedKeywords: Math.min(
        20,
        Math.max(5, Math.round(Math.log2(s.searchVolume) * 2))
      ),
      avgPrice: `$${Math.max(10, Math.round(s.cpc * 8))}-$${Math.max(40, Math.round(s.cpc * 40))}`,
      reasoning: `DataForSEO Labs (seed="${seed}"): vol=${s.searchVolume}/mo, CPC=$${s.cpc.toFixed(2)}, KD=${s.keywordDifficulty}`
    };
    agent.log(
      "info",
      `Scout DataForSEO: picked "${candidate.slug}" from seed "${seed}" (vol=${s.searchVolume} cpc=${s.cpc} kd=${s.keywordDifficulty})`,
      "legacyScout",
      { categorySlug: candidate.slug, kanbanStage: "planning" }
    );
    return candidate;
  }

  agent.log(
    "info",
    `Scout DataForSEO: seed "${seed}" returned ${result.suggestions.length} suggestions but none passed filters (vol>=${MIN_VOLUME}, cpc>0, kd<=${MAX_DIFFICULTY}, ${MIN_SLUG_SEGMENTS}+ slug segments, not duplicate) — falling through to AI scout`,
    "legacyScout",
    { kanbanStage: "planning" }
  );
  return null;
}

/**
 * Discover and persist the next high-ROI Amazon-affiliate cat product category
 * to cover. The function is the autonomous loop's planning step — it decides
 * *what* to write next so the pipeline never needs human input.
 *
 * Five-tier fallback strategy (tried in order):
 *  0. **DataForSEO Labs scout** — fetches 50 long-tail keyword
 *     suggestions for a rotating seed, picks the first non-duplicate
 *     suggestion that passes volume/CPC/difficulty filters. Uses real
 *     Google demand instead of Kimi's imagination.
 *  1. **AI scout** — calls Kimi K2.5 with a ROI-scoring prompt that
 *     lists already-covered categories so the model proposes fresh niches.
 *  2. **Hardcoded pool** — 130+ manually-curated cat-product
 *     niches, ordered by estimated ROI. Used when the AI returns only
 *     already-covered slugs or fails outright.
 *  3. **Slug-variant expansion** — appends content-type suffixes (e.g.
 *     `-reviews`, `-guide`) to every pool entry, yielding up to 600
 *     additional candidates when the base pool is exhausted.
 *  4. **Synthetic fallback** — inserts a time-stamped `cat-products-<epoch>`
 *     entry to guarantee a usable category is always returned.
 *
 * Side effects: inserts a new row into the `categories` table and calls
 * `generateKeywords` to populate the `keywords` table. Both writes happen
 * inside `saveCategory` before the function returns.
 *
 * Never throws — every tier is guarded, and Tier 4 ensures a
 * `DiscoveredCategory` is always returned even when all pool/variant slots
 * are exhausted.
 */
export async function scoutHighTicketCategory(
  agent: SEOArticleAgent
): Promise<DiscoveredCategory | null> {
  const existing = agent.sql<{ slug: string }>`SELECT slug FROM categories`;
  const excludedNorm = new Set(
    existing.map((r) => normalizeCategorySlug(r.slug)).filter(Boolean)
  );
  const excludedList = truncateExcludedListForPrompt(
    existing.map((r) => r.slug)
  );

  agent.log("info", `Scouting with ${existing.length} excluded categories...`);

  const scoutSystemPrompt =
    "You are a cat product Amazon affiliate niche analyst. Return ONLY valid JSON, no markdown. /no_think";
  const scoutUserPrompt = buildScoutRoiPrompt(excludedList, existing.length);
  const scoutPromptCell = formatActivityLogModelPromptCell(
    scoutSystemPrompt,
    scoutUserPrompt
  );

  // ── Tier 0: DataForSEO Labs ─────────────────────────────────────────────────
  // Try real-world long-tail demand BEFORE asking Kimi to imagine. The
  // Labs `keyword_suggestions/live` endpoint returns 50 expansions of a
  // seed keyword, each carrying real Google search volume, CPC, and
  // keyword difficulty. We rotate through a small seed set so different
  // facets of the catalog get explored over time, filter for commercial
  // viability (vol >= MIN, CPC > 0, KD <= MAX), and convert the first
  // non-duplicate suggestion into a `DiscoveredCategory`. Falls through
  // to Tier 1 silently when the API is down or returns nothing usable —
  // this tier is best-effort; the AI/pool fallbacks remain the
  // load-bearing safety net.
  const dataForSeoChoice = await scoutFromDataForSeo(agent, excludedNorm);
  if (dataForSeoChoice) {
    const saved = await saveCategory(agent, dataForSeoChoice, excludedNorm);
    if (saved) return saved;
  }

  // ── Tier 1: AI scout ────────────────────────────────────────────────────────
  // Runs on Cloudflare Workers AI (Qwen3-30B-A3B via `getScoutModel`) — no
  // OpenRouter credits and no Kimi quota. A single draw is occasionally
  // unlucky (returns only already-covered niches, or trips a transient
  // capacity error) and a bad draw wastes the whole 5-minute cycle, so take
  // up to 3 attempts per tick. maxOutputTokens stays generous so the ROI
  // JSON has room to complete.
  const scoutAttempts = 3;
  for (let attempt = 1; attempt <= scoutAttempts; attempt++) {
    try {
      const result = await generateText({
        model: getScoutModel(agent.envBindings),
        system: scoutSystemPrompt,
        prompt: scoutUserPrompt,
        maxOutputTokens: 2000
      });
      const { text } = result;

      // Log which Workers AI model answered so quality variance is
      // diagnosable from the dashboard.
      agent.log(
        "info",
        `Scout ROI AI (${result.response.modelId}, attempt ${attempt}/${scoutAttempts}): ${text.length} chars`,
        "legacyScout",
        {
          modelPrompt: scoutPromptCell,
          kanbanStage: "planning"
        }
      );

      const parsed = parseScoutRoiResponse(text);
      if (!parsed) {
        agent.log(
          "warning",
          `Scout AI: empty/unparseable response (attempt ${attempt}/${scoutAttempts}) — retrying Workers AI scout`,
          undefined,
          { modelPrompt: scoutPromptCell }
        );
        continue;
      }
      const chosen = pickFirstUnusedCategory(
        parsed.candidates,
        parsed.scores,
        excludedNorm
      );
      if (chosen) {
        const saved = await saveCategory(agent, chosen, excludedNorm);
        if (saved) return saved;
      }
      const first = parsed.candidates[0];
      if (first && excludedNorm.has(normalizeCategorySlug(first.slug))) {
        agent.log(
          "warning",
          `Scout AI: all ROI candidates already in database (e.g. ${first.slug}) (attempt ${attempt}/${scoutAttempts}) — retrying Workers AI scout`,
          undefined,
          { categorySlug: first.slug, modelPrompt: scoutPromptCell }
        );
      } else {
        agent.log(
          "warning",
          `Scout AI: no usable category in JSON (attempt ${attempt}/${scoutAttempts}) — retrying Workers AI scout`,
          undefined,
          { modelPrompt: scoutPromptCell }
        );
      }
    } catch (err: unknown) {
      agent.log(
        "warning",
        `Scout AI failed (attempt ${attempt}/${scoutAttempts}): ${errMsg(err)} — retrying Workers AI scout`,
        undefined,
        { modelPrompt: scoutPromptCell }
      );
    }
  }

  // ── Tier 2: hardcoded pool (base slugs) ─────────────────────────────────────
  for (const fallback of CATEGORY_POOL) {
    const key = normalizeCategorySlug(fallback.slug);
    if (excludedNorm.has(key)) continue;
    agent.log(
      "info",
      `Scout fallback: trying "${fallback.name}" from pool`,
      undefined,
      { categorySlug: fallback.slug }
    );
    const saved = await saveCategory(agent, fallback, excludedNorm);
    if (saved) return saved;
  }

  // ── Tier 3: slug-variant expansion (pool slug + suffix) ──────────────────────
  // Reached only when every base slug is already in the DB.  We append a
  // content-type suffix to each pool entry so we always have new ground to cover.
  agent.log(
    "warning",
    "Scout: base pool exhausted — expanding with slug-variant suffixes",
    "legacyScout",
    { kanbanStage: "planning" }
  );
  for (const suffix of POOL_VARIANT_SUFFIXES) {
    for (const base of CATEGORY_POOL) {
      const variantSlug = normalizeCategorySlug(base.slug + suffix);
      if (excludedNorm.has(variantSlug)) continue;
      const variant: DiscoveredCategory = {
        name: `${base.name} ${suffix
          .replace(/-/g, " ")
          .replace(/^\s+/, "")
          .replace(/\b\w/g, (c) => c.toUpperCase())}`,
        slug: variantSlug,
        estimatedKeywords: Math.max(
          5,
          Math.round(base.estimatedKeywords * 0.7)
        ),
        avgPrice: base.avgPrice,
        reasoning: `${base.reasoning} (variant: ${suffix.slice(1)})`
      };
      agent.log("info", `Scout variant: trying "${variant.slug}"`, undefined, {
        categorySlug: variant.slug
      });
      const saved = await saveCategory(agent, variant, excludedNorm);
      if (saved) return saved;
    }
  }

  // ── Tier 4: pool fully exhausted ─────────────────────────────────────────────
  // 100 base × 5 variants = 600 slugs. If we've blown through all of them
  // we're in unprecedented territory — something upstream is broken
  // (DataForSEO outage, all categories accidentally marked excluded, etc).
  //
  // Returning null fails the orchestrator loop loud: both callers already
  // handle null by logging "No categories to discover — idling" and
  // pausing for the next tick. That's strictly better than synthesizing
  // a generic "cat-products-misc" / "cat-products-${epoch}" category,
  // which would:
  //   - bake a thin-content, non-keyword-targeted URL into the live site
  //     (SEO-toxic, permanent)
  //   - hide the upstream failure mode so it never gets fixed
  //   - dump every distinct fallback into the same canonical folder
  //     (duplicate-content risk)
  agent.log(
    "error",
    "Scout: all 600+ pool/variant slugs exhausted — returning null so the orchestrator pauses instead of publishing into a synthetic category",
    "legacyScout",
    { kanbanStage: "debug" }
  );
  return null;
}

async function saveCategory(
  agent: SEOArticleAgent,
  cat: DiscoveredCategory,
  excludedNorm?: Set<string>
): Promise<DiscoveredCategory | null> {
  const slug = normalizeCategorySlug(cat.slug);

  // Guard: never insert a slug that is already in the DB.
  if (excludedNorm && excludedNorm.has(slug)) return null;

  const row = { ...cat, slug };

  // Use INSERT OR IGNORE so a race condition (two workers) never throws.
  agent.sql`INSERT OR IGNORE INTO categories (slug, name, avg_price, status, expected_count)
    VALUES (${row.slug}, ${row.name}, ${row.avgPrice || ""}, 'in_progress', ${row.estimatedKeywords || 10})`;

  // Verify the row landed (it won't if a race already inserted it).
  const inserted = agent.sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt FROM categories WHERE slug=${row.slug}`;
  if ((inserted[0]?.cnt ?? 0) === 0) {
    agent.log(
      "warning",
      `Scout: category "${row.slug}" already existed (race or duplicate) — skipping`,
      "legacyScout",
      { categorySlug: row.slug, kanbanStage: "debug" }
    );
    return null;
  }

  try {
    const { generateKeywords } = await import("./keywords");
    await generateKeywords(
      agent,
      row.name,
      row.slug,
      row.estimatedKeywords || 10
    );
  } catch (kwErr: unknown) {
    // Note: this catch only logs. The decision to insert a stub (or
    // SKIP under Kimi degradation) happens below at the kwCount === 0
    // check — the message previously said "inserting stub keyword so
    // category survives" which was misleading because the actual
    // insertion is downstream.
    agent.log(
      "warning",
      `Scout: generateKeywords threw for "${row.slug}": ${errMsg(kwErr)} — falling through to DataForSEO expansion + downstream stub check`,
      "legacyScout",
      { categorySlug: row.slug, kanbanStage: "debug" }
    );
  }

  // Expand the seed via DataForSEO Labs keyword suggestions — gives us 50
  // long-tail candidates with real demand data (search_volume, KD, CPC).
  // Quietly skips only when both creds are unset; partial config logs a
  // warning so degraded scout coverage is visible in activity logs.
  await expandWithKeywordSuggestions(agent, row.name, row.slug);

  const cntRows = agent.sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM keywords WHERE category_slug=${row.slug}`;
  const kwCount = cntRows[0]?.cnt ?? 0;

  if (kwCount === 0) {
    // Do NOT insert a stub keyword when Kimi is currently degraded.
    // The stub is `best <category-name>` — a verbatim restatement of
    // the category slug. When Kimi is healthy that's a usable seed
    // that gets enriched on the next cycle. When Kimi is degraded
    // (OpenRouter credits dry), the stub never gets enriched —
    // generateKeywords keeps failing the same way — and we end up
    // publishing thousands of articles for category-slug stubs that
    // nobody searches for, polluting site authority. Per the
    // north-star: better to leave the category temporarily empty
    // (scout retries on the next cycle) than to publish degraded
    // content the system will have to live with forever.
    if (isKimiCurrentlyDegraded(agent.state.activityLog ?? [])) {
      agent.log(
        "warning",
        `Scout: category "${row.slug}" has 0 keywords AND Kimi is degraded — SKIPPING stub insertion. Category will be retried next scout cycle once OpenRouter credits return.`,
        "legacyScout",
        { categorySlug: row.slug, kanbanStage: "debug" }
      );
    } else {
      // Do NOT delete the category.  Instead insert a stub keyword so the
      // pipeline always has something to work with.  The keyword generator
      // will enrich it on the next cycle.
      insertStubKeyword(agent, row.slug, row.name);
    }
  }

  return row;
}

/**
 * Expand the category seed (e.g. "Cat Water Fountains") via DataForSEO Labs
 * keyword suggestions, persisting up to 50 long-tail candidates ranked by
 * `searchVolume * (100 - keywordDifficulty)` ROI proxy. Each candidate is
 * INSERT-OR-IGNORE'd into the keywords table — the existing rows from
 * `generateKeywords()` are untouched if the DataForSEO suggestion duplicates
 * a slug. Quietly skips only when both DATAFORSEO_LOGIN and
 * DATAFORSEO_PASSWORD are unset; partial configuration logs a warning.
 */
async function expandWithKeywordSuggestions(
  agent: SEOArticleAgent,
  categoryName: string,
  categorySlug: string
): Promise<void> {
  const { creds, missing } = resolveDataForSeoCreds(
    agent.envBindings.DATAFORSEO_LOGIN,
    agent.envBindings.DATAFORSEO_PASSWORD
  );
  if (!creds) {
    if (missing.length === 1) {
      agent.log(
        "warning",
        `Scout: keyword_suggestions skipped for "${categoryName}": missing ${missing[0]}; set both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to enable DataForSEO expansion`,
        "operations",
        { categorySlug }
      );
    }
    return;
  }

  const result = await fetchKeywordSuggestions(creds, categoryName, {
    limit: 50
  });
  if ("error" in result) {
    agent.log(
      "warning",
      `Scout: keyword_suggestions for "${categoryName}": ${result.error}`,
      "operations",
      { categorySlug }
    );
    return;
  }

  // Rank by ROI proxy (higher = better) before insert so the most promising
  // long-tails sit at the top of the queue.
  const ranked = [...result.suggestions].sort((a, b) => {
    const aScore = a.searchVolume * (100 - a.keywordDifficulty);
    const bScore = b.searchVolume * (100 - b.keywordDifficulty);
    return bScore - aScore;
  });

  const existingKeywordIds = new Set(
    agent.sql<{ id: string }>`
        SELECT id FROM keywords WHERE category_slug=${categorySlug}
      `.map((row) => row.id)
  );

  let inserted = 0;
  for (const sugg of ranked) {
    const kw = sugg.keyword.trim();
    if (!kw || kw.split(/\s+/).length > 7) continue;
    const slug = keywordToSlug(kw);
    if (!slug) continue;
    const id = `${categorySlug}:${slug}`;
    if (existingKeywordIds.has(id)) continue;
    agent.sql`INSERT OR IGNORE INTO keywords
      (id, category_slug, keyword, slug, search_volume, keyword_difficulty, cpc)
      VALUES (${id}, ${categorySlug}, ${kw}, ${slug},
        ${sugg.searchVolume}, ${Math.round(sugg.keywordDifficulty)}, ${sugg.cpc})`;
    existingKeywordIds.add(id);
    inserted++;
  }

  if (inserted > 0) {
    agent.log(
      "info",
      `Scout: DataForSEO keyword_suggestions added ${inserted} long-tails for "${categoryName}"`,
      "strategist",
      { categorySlug, kanbanStage: "planning" }
    );
  } else {
    const returnedCount = result.suggestions.length;
    const reason =
      returnedCount > 0
        ? `all ${returnedCount} suggestion(s) filtered (> 7 words or unslugifiable)`
        : "0 suggestions returned by DataForSEO";
    agent.log(
      "info",
      `Scout: DataForSEO keyword_suggestions: no long-tails added for "${categoryName}" — ${reason}`,
      "strategist",
      { categorySlug }
    );
  }
}
