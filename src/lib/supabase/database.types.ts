export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      legs: {
        Row: {
          arrives_at: string | null
          computed_at: string | null
          departs_at: string | null
          detail: Json | null
          distance_meters: number | null
          duration_minutes: number | null
          estimated_cost: number | null
          from_stop_id: string
          id: string
          mode: string
          polyline: string | null
          source: string
          stale: boolean
          to_stop_id: string
          trip_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          arrives_at?: string | null
          computed_at?: string | null
          departs_at?: string | null
          detail?: Json | null
          distance_meters?: number | null
          duration_minutes?: number | null
          estimated_cost?: number | null
          from_stop_id: string
          id?: string
          mode: string
          polyline?: string | null
          source: string
          stale?: boolean
          to_stop_id: string
          trip_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          arrives_at?: string | null
          computed_at?: string | null
          departs_at?: string | null
          detail?: Json | null
          distance_meters?: number | null
          duration_minutes?: number | null
          estimated_cost?: number | null
          from_stop_id?: string
          id?: string
          mode?: string
          polyline?: string | null
          source?: string
          stale?: boolean
          to_stop_id?: string
          trip_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "legs_from_stop_id_trip_id_fkey"
            columns: ["from_stop_id", "trip_id"]
            isOneToOne: false
            referencedRelation: "stops"
            referencedColumns: ["id", "trip_id"]
          },
          {
            foreignKeyName: "legs_to_stop_id_trip_id_fkey"
            columns: ["to_stop_id", "trip_id"]
            isOneToOne: false
            referencedRelation: "stops"
            referencedColumns: ["id", "trip_id"]
          },
          {
            foreignKeyName: "legs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          display_name: string | null
          id: string
        }
        Insert: {
          avatar_url?: string | null
          display_name?: string | null
          id: string
        }
        Update: {
          avatar_url?: string | null
          display_name?: string | null
          id?: string
        }
        Relationships: []
      }
      route_cache: {
        Row: {
          cache_key: string
          fetched_at: string
          result: Json
        }
        Insert: {
          cache_key: string
          fetched_at?: string
          result: Json
        }
        Update: {
          cache_key?: string
          fetched_at?: string
          result?: Json
        }
        Relationships: []
      }
      stops: {
        Row: {
          ends_at: string
          estimated_cost: number | null
          id: string
          is_custom: boolean
          lat: number
          lng: number
          locked: boolean
          name: string
          notes: string | null
          place_id: string | null
          place_refreshed_at: string | null
          starts_at: string
          timezone: string
          trip_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          ends_at: string
          estimated_cost?: number | null
          id?: string
          is_custom?: boolean
          lat: number
          lng: number
          locked?: boolean
          name: string
          notes?: string | null
          place_id?: string | null
          place_refreshed_at?: string | null
          starts_at: string
          timezone: string
          trip_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          ends_at?: string
          estimated_cost?: number | null
          id?: string
          is_custom?: boolean
          lat?: number
          lng?: number
          locked?: boolean
          name?: string
          notes?: string | null
          place_id?: string | null
          place_refreshed_at?: string | null
          starts_at?: string
          timezone?: string
          trip_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stops_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_candidates: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          lat: number
          lng: number
          name: string
          place_id: string
          trip_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          lat: number
          lng: number
          name: string
          place_id: string
          trip_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          lat?: number
          lng?: number
          name?: string
          place_id?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_candidates_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_invites: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          role: string
          trip_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          role: string
          trip_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          role?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_invites_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_members: {
        Row: {
          joined_at: string
          role: string
          trip_id: string
          user_id: string
        }
        Insert: {
          joined_at?: string
          role: string
          trip_id: string
          user_id: string
        }
        Update: {
          joined_at?: string
          role?: string
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_members_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_snapshots: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          label: string
          snapshot: Json
          snapshot_version: number
          trip_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          label: string
          snapshot: Json
          snapshot_version?: number
          trip_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          label?: string
          snapshot?: Json
          snapshot_version?: number
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_snapshots_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          created_at: string
          currency: string
          end_date: string
          id: string
          owner_id: string | null
          share_token: string
          start_date: string
          title: string
        }
        Insert: {
          created_at?: string
          currency?: string
          end_date: string
          id?: string
          owner_id?: string | null
          share_token?: string
          start_date: string
          title: string
        }
        Update: {
          created_at?: string
          currency?: string
          end_date?: string
          id?: string
          owner_id?: string | null
          share_token?: string
          start_date?: string
          title?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_trip_invite: { Args: { p_token: string }; Returns: string }
      cascade_shift_stops: {
        Args: {
          p_changed_stop_id: string
          p_delta_seconds: number
          p_trip_id: string
        }
        Returns: undefined
      }
      is_trip_editor: { Args: { p_trip_id: string }; Returns: boolean }
      is_trip_member: { Args: { p_trip_id: string }; Returns: boolean }
      is_trip_owner: { Args: { p_trip_id: string }; Returns: boolean }
      my_trip_ids: { Args: never; Returns: string[] }
      regenerate_share_token: { Args: { p_trip_id: string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

