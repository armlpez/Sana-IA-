import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsInt, Max, Min } from 'class-validator';

/** Postgres int4 upper bound — consultation.id is a plain serial integer. */
const PG_INT4_MAX = 2_147_483_647;

export class DeleteConversationsDto {
    /**
     * Consultation ids to delete. Capped at 50 per request as a defensive
     * bound for a destructive bulk operation (no legitimate client screen
     * selects more than a page of conversations at once).
     *
     * Min/Max bound every id to the valid serial-int4 range: without them, an
     * id beyond int4 passes @IsInt but blows up inside Postgres ("value out of
     * range for type integer") — an authenticated attacker could mint 500s on
     * demand. Out-of-range ids are a client bug or an attack either way; 400 fast.
     */
    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(50)
    @IsInt({ each: true })
    @Min(1, { each: true })
    @Max(PG_INT4_MAX, { each: true })
    ids: number[];
}
